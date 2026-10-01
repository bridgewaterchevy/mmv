import type { Express, Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import multer from "multer";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { storage, toPublic, verifyPin, getDb } from "./storage";
import { files, removeUpload } from "./files";
import { enqueueAnalysis, recoverStuckAnalyses, startAnalysisSweeper } from "./analysis";
import { lookupOffers, buildShoppingQuery } from "./prices";
import { presentOffers } from "./affiliate";
import { registerFeedbackRoutes, isAdmin } from "./feedback";
import type { User, PricedItem } from "@shared/schema";
import { ACTIVITIES, SHOP_FOR } from "@shared/schema";

// ---- tiny in-memory rate limiter (per key, sliding window) ----
const buckets = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    buckets.set(key, arr);
    return true;
  }
  arr.push(now);
  buckets.set(key, arr);
  return false;
}
const ip = (req: Request) => (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.ip || "?";

// ---- image signature check (don't trust the declared MIME type) ----
function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: ".jpg", mime: "image/jpeg" };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: ".png", mime: "image/png" };
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return { ext: ".webp", mime: "image/webp" };
  if (buf.subarray(0, 3).toString("ascii") === "GIF") return { ext: ".gif", mime: "image/gif" };
  const ftyp = buf.subarray(4, 8).toString("ascii");
  const brand = buf.subarray(8, 12).toString("ascii");
  if (ftyp === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1|heif)$/.test(brand)) return { ext: ".heic", mime: "image/heic" };
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|heic|heif|gif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error("Please upload a photo (JPG, PNG, HEIC or WebP)"));
  },
});

type AuthedRequest = Request & { user: User };

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.headers["x-auth-token"] as string | undefined;
    const user = token ? await storage.getUserByToken(token) : undefined;
    if (!user) return res.status(401).json({ message: "Sign in first" });
    (req as AuthedRequest).user = user;
    next();
  } catch (err) {
    next(err);
  }
}

const handleSchema = z
  .string()
  .min(2)
  .max(20)
  .regex(/^[a-z0-9_]+$/i, "Letters, numbers and underscores only");
const pinSchema = z.string().regex(/^\d{4}$/, "PIN must be 4 digits");
// "womens" | "mens" | "unisex" | null. Optional on signup; PATCH /api/me requires the key (null clears it).
const shopForSchema = z.enum(SHOP_FOR, { message: "shopFor must be womens, mens or unisex" }).nullable();

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // Boot order: database (creates tables) then file store (creates bucket if needed).
  await getDb();
  await files.init(app);
  // Background outfit analysis: re-queue picks left "pending" by a previous process, then keep sweeping.
  recoverStuckAnalyses().catch((err) => console.error("[analysis] startup recovery failed", err));
  startAnalysisSweeper();

  // Polled resources must never be served from an HTTP cache.
  const noStore = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };

  // ---------- health (keep-alive pinger / Render health check) ----------
  app.get("/api/health", async (_req, res) => {
    // Touches the database so keep-alive pings count as activity for Supabase's idle-pause policy.
    try {
      const db = await getDb();
      await db.execute(sql`select 1`);
      res.json({ ok: true, db: true });
    } catch (err) {
      console.error("health db check failed", err);
      res.status(503).json({ ok: false, db: false });
    }
  });

  // ---------- auth ----------
  app.post("/api/auth/signup", async (req, res) => {
    if (limited(`signup:${ip(req)}`, 10, 60 * 60 * 1000)) return res.status(429).json({ message: "Too many sign-ups from this network. Try again later." });
    const body = z
      .object({ name: z.string().min(1).max(40), handle: handleSchema, pin: pinSchema, shopFor: shopForSchema.optional() })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: body.error.issues[0]?.message ?? "Invalid" });
    if (await storage.getUserByHandle(body.data.handle)) return res.status(409).json({ message: "That handle is taken" });
    const user = await storage.createUser({ ...body.data, shopFor: body.data.shopFor ?? null });
    res.json({ token: user.token, user: toPublic(user) });
  });

  app.post("/api/auth/login", async (req, res) => {
    const body = z.object({ handle: handleSchema, pin: pinSchema }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: body.error.issues[0]?.message ?? "Invalid" });
    const handle = body.data.handle.toLowerCase();
    if (limited(`login:${handle}`, 6, 15 * 60 * 1000) || limited(`login-ip:${ip(req)}`, 30, 15 * 60 * 1000))
      return res.status(429).json({ message: "Too many attempts. Wait 15 minutes and try again." });
    const user = await storage.getUserByHandle(handle);
    if (!user || !verifyPin(body.data.pin, user.pin)) return res.status(401).json({ message: "Wrong handle or PIN" });
    res.json({ token: user.token, user: toPublic(user) });
  });

  // PublicUser plus `isAdmin` (handle listed in ADMIN_HANDLES → may use the admin feedback endpoints).
  app.get("/api/me", requireAuth, async (req, res) => {
    const user = (req as AuthedRequest).user;
    res.json({ ...toPublic(user), isAdmin: isAdmin(user) });
  });

  // Profile preferences. Body: { shopFor: "womens" | "mens" | "unisex" | null }. Returns the updated PublicUser.
  app.patch("/api/me", requireAuth, async (req, res) => {
    const body = z.object({ shopFor: shopForSchema }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: body.error.issues[0]?.message ?? "Invalid" });
    const user = await storage.updateUser((req as AuthedRequest).user.id, { shopFor: body.data.shopFor });
    res.json(toPublic(user));
  });

  // ---------- crews ----------
  app.get("/api/crews", requireAuth, async (req, res) => {
    res.json(await storage.crewsForUser((req as AuthedRequest).user.id));
  });

  app.post("/api/crews", requireAuth, async (req, res) => {
    const body = z.object({ name: z.string().min(1).max(40), activity: z.enum(ACTIVITIES) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Give the crew a name and an activity" });
    const crew = await storage.createCrew(body.data, (req as AuthedRequest).user.id);
    res.json(await storage.crewView(crew));
  });

  app.post("/api/crews/join", requireAuth, async (req, res) => {
    const body = z.object({ inviteCode: z.string().min(4).max(10) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Enter an invite code" });
    const crew = await storage.getCrewByInvite(body.data.inviteCode.trim());
    if (!crew) return res.status(404).json({ message: "No crew with that code" });
    await storage.joinCrew(crew.id, (req as AuthedRequest).user.id);
    res.json(await storage.crewView(crew));
  });

  app.get("/api/crews/:id", requireAuth, async (req, res) => {
    const crew = await storage.getCrew(Number(req.params.id));
    if (!crew || !(await storage.isMember(crew.id, (req as AuthedRequest).user.id))) return res.status(404).json({ message: "Crew not found" });
    res.json({ ...(await storage.crewView(crew)), sessions: await storage.sessionsForCrew(crew.id) });
  });

  // ---------- days (auto-created sessions) ----------
  app.get("/api/crews/:id/day/:date", requireAuth, noStore, async (req, res) => {
    const crew = await storage.getCrew(Number(req.params.id));
    const user = (req as AuthedRequest).user;
    if (!crew || !(await storage.isMember(crew.id, user.id))) return res.status(404).json({ message: "Crew not found" });
    const date = String(req.params.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: "Bad date" });
    res.json(await storage.sessionView(await storage.getOrCreateDay(crew.id, date, user.id)));
  });

  app.patch("/api/sessions/:id", requireAuth, async (req, res) => {
    const s = await storage.getSession(Number(req.params.id));
    const user = (req as AuthedRequest).user;
    if (!s || !(await storage.isMember(s.crewId, user.id))) return res.status(404).json({ message: "Session not found" });
    const body = z.object({ title: z.string().min(1).max(60).optional(), vibe: z.string().max(60).nullable().optional() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Invalid" });
    const data: { title?: string; vibe?: string | null } = {};
    if (body.data.title !== undefined) data.title = body.data.title.trim();
    if (body.data.vibe !== undefined) data.vibe = body.data.vibe?.trim() || null;
    res.json(await storage.sessionView(await storage.updateSession(s.id, data)));
  });

  // ---------- sessions ----------
  app.post("/api/sessions", requireAuth, async (req, res) => {
    const body = z
      .object({
        crewId: z.number(),
        title: z.string().min(1).max(60),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        vibe: z.string().max(60).optional().nullable(),
      })
      .safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Title and date are required" });
    const user = (req as AuthedRequest).user;
    if (!(await storage.isMember(body.data.crewId, user.id))) return res.status(403).json({ message: "Not your crew" });
    const s = await storage.createSession(body.data, user.id);
    res.json(await storage.sessionView(s));
  });

  app.get("/api/sessions/:id", requireAuth, noStore, async (req, res) => {
    const s = await storage.getSession(Number(req.params.id));
    if (!s || !(await storage.isMember(s.crewId, (req as AuthedRequest).user.id))) return res.status(404).json({ message: "Session not found" });
    res.json(await storage.sessionView(s));
  });

  // ---------- picks ----------
  const uploadPhoto = (req: Request, res: Response, next: NextFunction) =>
    upload.single("photo")(req, res, (err?: unknown) => {
      if (err) return res.status(400).json({ message: (err as Error).message || "Upload failed" });
      next();
    });

  const requireSessionMember = async (req: Request, res: Response, next: NextFunction) => {
    const s = await storage.getSession(Number(req.params.id));
    const user = (req as AuthedRequest).user;
    if (!s || !(await storage.isMember(s.crewId, user.id))) return res.status(404).json({ message: "Session not found" });
    if (limited(`upload:${user.id}`, 20, 60 * 60 * 1000)) return res.status(429).json({ message: "That's a lot of outfits. Try again in a bit." });
    next();
  };

  /**
   * Post an outfit. Responds 201 as soon as the photo is stored; the Gemini analysis runs in the background
   * (server/analysis.ts) and the PickView comes back with analysisStatus "pending", items [] and palette [].
   * Poll GET /api/picks/:id until analysisStatus is "ready" | "failed".
   */
  app.post("/api/sessions/:id/picks", requireAuth, requireSessionMember, uploadPhoto, noStore, async (req, res) => {
    const s = (await storage.getSession(Number(req.params.id)))!;
    const user = (req as AuthedRequest).user;
    if (!req.file) return res.status(400).json({ message: "Add a photo of the outfit" });
    const kind = sniffImage(req.file.buffer);
    if (!kind) return res.status(400).json({ message: "That file isn't a photo we can read (JPG, PNG, HEIC or WebP)" });
    const note = typeof req.body.note === "string" ? req.body.note.slice(0, 200).trim() : null;

    const previous = await storage.getPickForUser(s.id, user.id);
    const photoPath = await files.put(req.file.buffer, kind.ext, kind.mime);
    const pick = await storage.upsertPick({
      sessionId: s.id,
      userId: user.id,
      photoPath,
      note: note || null,
      palette: [],
      items: [],
      analysisStatus: "pending",
    });
    if (previous && previous.photoPath !== pick.photoPath) void removeUpload(previous.photoPath);
    res.status(201).json(await storage.pickView(pick));
    // Fire-and-forget: enqueueAnalysis never throws, and job errors are recorded on the row.
    try {
      enqueueAnalysis({ pickId: pick.id, photoPath, buffer: req.file.buffer, mime: kind.mime, reason: "upload" });
    } catch (err) {
      console.error("[analysis] enqueue failed", err);
    }
  });

  // Poll target for the background analysis (any crew member). Same PickView shape as the session view.
  app.get("/api/picks/:id", requireAuth, noStore, async (req, res) => {
    const pick = await storage.getPick(Number(req.params.id));
    const user = (req as AuthedRequest).user;
    if (!pick) return res.status(404).json({ message: "Pick not found" });
    const s = await storage.getSession(pick.sessionId);
    if (!s || !(await storage.isMember(s.crewId, user.id))) return res.status(403).json({ message: "Not your crew" });
    res.json(await storage.pickView(pick));
  });

  // Owner-only: re-run the outfit analysis (after a failure, or to refresh). Returns the PickView with status "pending".
  app.post("/api/picks/:id/analyze", requireAuth, noStore, async (req, res) => {
    const pick = await storage.getPick(Number(req.params.id));
    const user = (req as AuthedRequest).user;
    if (!pick) return res.status(404).json({ message: "Pick not found" });
    if (pick.userId !== user.id) return res.status(403).json({ message: "Only the owner can re-run the analysis" });
    if (pick.analysisStatus === "pending") return res.status(202).json(await storage.pickView(pick)); // already queued
    if (limited(`analyze:${user.id}`, 10, 60 * 60 * 1000)) return res.status(429).json({ message: "Too many retries. Try again in a bit." });
    const updated = (await storage.markAnalysisPending(pick.id)) ?? pick;
    res.json(await storage.pickView(updated));
    try {
      enqueueAnalysis({ pickId: pick.id, photoPath: updated.photoPath, reason: "retry" });
    } catch (err) {
      console.error("[analysis] enqueue failed", err);
    }
  });

  app.patch("/api/picks/:id", requireAuth, async (req, res) => {
    const pick = await storage.getPick(Number(req.params.id));
    const user = (req as AuthedRequest).user;
    if (!pick || pick.userId !== user.id) return res.status(404).json({ message: "Pick not found" });
    const body = z.object({ locked: z.boolean() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: "Invalid" });
    res.json(await storage.pickView(await storage.setLocked(pick.id, body.data.locked)));
  });

  app.delete("/api/picks/:id", requireAuth, async (req, res) => {
    const pick = await storage.getPick(Number(req.params.id));
    const user = (req as AuthedRequest).user;
    if (!pick || pick.userId !== user.id) return res.status(404).json({ message: "Pick not found" });
    await storage.deletePick(pick.id);
    void removeUpload(pick.photoPath);
    res.json({ ok: true });
  });

  app.post("/api/picks/:id/reactions", requireAuth, async (req, res) => {
    const pick = await storage.getPick(Number(req.params.id));
    const user = (req as AuthedRequest).user;
    if (!pick) return res.status(404).json({ message: "Pick not found" });
    const s = (await storage.getSession(pick.sessionId))!;
    if (!(await storage.isMember(s.crewId, user.id))) return res.status(403).json({ message: "Not your crew" });
    const body = z.object({ emoji: z.string().max(8).optional(), comment: z.string().min(1).max(200).optional() }).safeParse(req.body);
    if (!body.success || (!body.data.emoji && !body.data.comment)) return res.status(400).json({ message: "Invalid" });
    await storage.addReaction({ pickId: pick.id, userId: user.id, emoji: body.data.emoji, comment: body.data.comment });
    res.json(await storage.pickView(pick));
  });

  // Lazy shopping prices for a pick: called when a member opens the pick, never at upload.
  // Looks up the first 4 items concurrently (each lookup is cached 24h and budget-guarded in server/prices.ts).
  // The query carries a women's/men's hint from the PICK OWNER's shopFor (the outfit is theirs), else the
  // garment's vision `fit` — see buildShoppingQuery. The hinted string is the price_cache key.
  app.get("/api/picks/:id/prices", requireAuth, async (req, res) => {
    const pick = await storage.getPick(Number(req.params.id));
    const user = (req as AuthedRequest).user;
    if (!pick) return res.status(404).json({ message: "Pick not found" });
    const s = await storage.getSession(pick.sessionId);
    if (!s || !(await storage.isMember(s.crewId, user.id))) return res.status(403).json({ message: "Not your crew" });
    if (limited(`prices:${user.id}`, 120, 60 * 60 * 1000)) return res.status(429).json({ message: "Slow down a little." });
    const view = await storage.pickView(pick); // items already hinted (shoppingQuery) + affiliate-wrapped
    const offerLists = await Promise.all(
      view.items.slice(0, 4).map((it) =>
        lookupOffers(it.shoppingQuery || buildShoppingQuery(it, view.user)).catch((err) => {
          console.error("prices lookup failed", err);
          return [];
        }),
      ),
    );
    const items: PricedItem[] = view.items.map((it, i) => ({ ...it, offers: presentOffers(offerLists[i] ?? []) }));
    res.json({ pickId: pick.id, items });
  });

  // ---------- closet (wear history) ----------
  app.get("/api/closet", requireAuth, async (req, res) => {
    res.json(await storage.picksForUser((req as AuthedRequest).user.id));
  });

  // ---------- "Report a problem" (server/feedback.ts) ----------
  registerFeedbackRoutes(app, { requireAuth, limited, sniffImage, ip });

  return httpServer;
}
