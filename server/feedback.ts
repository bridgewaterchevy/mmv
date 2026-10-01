/**
 * "Report a problem" / "Suggest an idea" API.
 *
 *   POST  /api/feedback        signed-in user; JSON or multipart (optional `screenshot` image ≤ 5 MB).
 *                              `kind` = "problem" (default) | "suggestion"; anything else is a 400.
 *   GET   /api/feedback        admin only (handle ∈ ADMIN_HANDLES); latest 100 reports with reporter.
 *                              Optional ?kind=problem|suggestion filter (invalid value -> 400).
 *   PATCH /api/feedback/:id    admin only; { status: "open" | "resolved" }
 *
 * Reports are always stored first; the GitHub issue (server/github.ts) is best-effort and its URL is
 * saved on the row when it succeeds. Limits are shared across kinds: 5 per user per hour (DB-counted,
 * survives restarts) and 20 per IP per hour (in-memory, like the other limiters).
 */
import type { Express, Request, Response, NextFunction } from "express";
import multer from "multer";
import { storage } from "./storage";
import { files } from "./files";
import { fileGithubIssue } from "./github";
import { feedbackBodySchema, feedbackStatusSchema, FEEDBACK_KINDS } from "@shared/schema";
import type { User, FeedbackCreated, FeedbackReport, FeedbackKind } from "@shared/schema";

export const FEEDBACK_PER_USER_PER_HOUR = 5;
export const FEEDBACK_PER_IP_PER_HOUR = 20;
export const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;

type AuthedRequest = Request & { user: User };

export interface FeedbackDeps {
  requireAuth: (req: Request, res: Response, next: NextFunction) => unknown;
  /** Sliding-window limiter from routes.ts: true when the key is over budget (and records the hit). */
  limited: (key: string, max: number, windowMs: number) => boolean;
  sniffImage: (buf: Buffer) => { ext: string; mime: string } | null;
  ip: (req: Request) => string;
}

/** Handles listed in ADMIN_HANDLES (comma-separated, case-insensitive). */
export function adminHandles(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.ADMIN_HANDLES || "")
      .split(",")
      .map((h) => h.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean),
  );
}
export function isAdmin(user: Pick<User, "handle">, env: NodeJS.ProcessEnv = process.env): boolean {
  return adminHandles(env).has(user.handle.toLowerCase());
}

const screenshotUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SCREENSHOT_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|heic|heif|gif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error("Screenshot must be an image (JPG, PNG, HEIC, GIF or WebP)"));
  },
});

/** Multipart fields arrive as strings; "" / "null" / "undefined" mean "not provided". */
function clean(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  if (!s || s === "null" || s === "undefined") return null;
  return s;
}

export function registerFeedbackRoutes(app: Express, deps: FeedbackDeps) {
  const { requireAuth, limited, sniffImage, ip } = deps;

  const uploadScreenshot = (req: Request, res: Response, next: NextFunction) =>
    screenshotUpload.single("screenshot")(req, res, (err?: unknown) => {
      if (err) {
        const e = err as Error & { code?: string };
        const message = e.code === "LIMIT_FILE_SIZE" ? "Screenshot must be 5 MB or smaller" : e.message || "Upload failed";
        return res.status(400).json({ message });
      }
      next();
    });

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!isAdmin((req as AuthedRequest).user)) return res.status(403).json({ message: "Admins only" });
    next();
  };

  app.post("/api/feedback", requireAuth, uploadScreenshot, async (req, res, next) => {
    try {
      const user = (req as AuthedRequest).user;
      const raw = (req.body ?? {}) as Record<string, unknown>;
      const parsed = feedbackBodySchema.safeParse({
        kind: clean(raw.kind) ?? undefined, // "" / missing -> default "problem"
        message: typeof raw.message === "string" ? raw.message : raw.message === undefined ? undefined : String(raw.message),
        page: clean(raw.page),
        userAgent: clean(raw.userAgent),
        appVersion: clean(raw.appVersion),
        lastError: clean(raw.lastError),
      });
      if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Tell us what went wrong" });

      // Validate the screenshot bytes before spending any rate-limit budget.
      let shot: { buffer: Buffer; ext: string; mime: string } | null = null;
      if (req.file) {
        const kind = sniffImage(req.file.buffer);
        if (!kind) return res.status(400).json({ message: "That screenshot isn't an image we can read (JPG, PNG, HEIC, GIF or WebP)" });
        shot = { buffer: req.file.buffer, ...kind };
      }

      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      if ((await storage.countFeedbackSince(user.id, hourAgo)) >= FEEDBACK_PER_USER_PER_HOUR)
        return res.status(429).json({ message: "You've sent a few reports already. Try again in an hour." });
      if (limited(`feedback-ip:${ip(req)}`, FEEDBACK_PER_IP_PER_HOUR, 60 * 60 * 1000))
        return res.status(429).json({ message: "Too many reports from this network. Try again later." });

      let report = await storage.createFeedback({
        userId: user.id,
        kind: parsed.data.kind,
        message: parsed.data.message,
        page: parsed.data.page ?? (typeof req.headers.referer === "string" ? req.headers.referer.slice(0, 500) : null),
        userAgent: parsed.data.userAgent ?? (typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 1000) : null),
        appVersion: parsed.data.appVersion ?? null,
        lastError: parsed.data.lastError ?? null,
      });

      if (shot) {
        try {
          const screenshotPath = await files.put(shot.buffer, shot.ext, shot.mime, `feedback/${report.id}${shot.ext}`);
          report = await storage.updateFeedback(report.id, { screenshotPath });
        } catch (err) {
          // The report itself is already saved; a lost screenshot must not fail the request.
          console.error(`[feedback] screenshot upload failed for #${report.id}`, err);
        }
      }

      const issue = await fileGithubIssue(report, { id: user.id, name: user.name, handle: user.handle });
      if (issue.url) report = await storage.updateFeedback(report.id, { githubIssueUrl: issue.url });

      const body: FeedbackCreated = { id: report.id, kind: report.kind, githubIssueUrl: report.githubIssueUrl ?? null };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/feedback", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const rawKind = clean(req.query.kind);
      if (rawKind && !(FEEDBACK_KINDS as readonly string[]).includes(rawKind))
        return res.status(400).json({ message: 'kind must be "problem" or "suggestion"' });
      res.json(await storage.listFeedback(100, (rawKind as FeedbackKind | null) ?? undefined));
    } catch (err) {
      next(err);
    }
  });

  app.patch("/api/feedback/:id", requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const report = await storage.getFeedback(Number(req.params.id));
      if (!report) return res.status(404).json({ message: "Report not found" });
      const body = feedbackStatusSchema.safeParse(req.body);
      if (!body.success) return res.status(400).json({ message: 'status must be "open" or "resolved"' });
      const updated = await storage.updateFeedback(report.id, { status: body.data.status });
      const [reporter] = await storage.getUsers([updated.userId]);
      const view: FeedbackReport = { ...updated, user: reporter ? { id: reporter.id, name: reporter.name, handle: reporter.handle } : null };
      res.json(view);
    } catch (err) {
      next(err);
    }
  });
}
