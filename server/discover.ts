/**
 * Discover: the PUBLIC, shoppable side of picks.
 *
 *   POST   /api/picks/:id/share           owner; { caption?, vibe, photoIds? } → 201 PostView (one post per pick: create or update)
 *   DELETE /api/posts/:id                 owner or admin → status "removed" (owner may re-share; admin removal is sticky)
 *   GET    /api/discover                  PUBLIC; ?cursor=&vibe=&sort=new|top → { posts: PostView[], nextCursor } (12/page, active only)
 *   GET    /api/posts/:id                 PUBLIC PostView; 404 for hidden/removed unless owner/admin
 *   GET    /api/posts/:id/prices          PUBLIC; same price pipeline (budget + 24h cache) as GET /api/picks/:id/prices; 30/h/IP
 *   POST   /api/posts/:id/like            auth; toggle → { likeCount, likedByMe }
 *   POST   /api/posts/:id/report          auth optional; 5/h/IP; { reason } → 201 { id, reportCount, hidden }; 3 distinct reporters auto-hide
 *   GET    /api/users/:handle             PUBLIC profile; GET /api/users/:handle/posts?cursor= PUBLIC page
 *   POST   /api/users/:handle/follow      auth; toggle → { following, followerCount }
 *   GET    /api/admin/posts?status=       admin; PATCH /api/admin/posts/:id { status }; GET /api/admin/reports
 *
 * A token is never REQUIRED on the public routes, but when a valid x-auth-token is sent it fills likedByMe /
 * isFollowedByMe / isMine. Public payloads never include the pick's note, crew or session data, or photos the owner
 * did not choose for the post (see PostView in shared/schema.ts and storage.postViews).
 */
import type { Express, Request, Response, NextFunction } from "express";
import { storage, decodeCursor } from "./storage";
import { isAdmin } from "./feedback";
import { sharePostBodySchema, postReportBodySchema, postStatusSchema, POST_VIBES, POST_STATUSES, DISCOVER_SORTS } from "@shared/schema";
import type { User, PricedItem, PickView, PostVibe, PostStatus, DiscoverSort } from "@shared/schema";

export const POST_PRICES_PER_IP_PER_HOUR = 30;
export const POST_REPORTS_PER_IP_PER_HOUR = 5;
export const SHARES_PER_USER_PER_HOUR = 30;
export const LIKES_PER_USER_PER_HOUR = 300;
export const FOLLOWS_PER_USER_PER_HOUR = 120;

type AuthedRequest = Request & { user: User };
type MaybeAuthedRequest = Request & { user?: User };

export interface DiscoverDeps {
  requireAuth: (req: Request, res: Response, next: NextFunction) => unknown;
  limited: (key: string, max: number, windowMs: number) => boolean;
  ip: (req: Request) => string;
  /** The shared price lookup used by GET /api/picks/:id/prices (budget + cache live in server/prices.ts). */
  priceItems: (view: PickView) => Promise<PricedItem[]>;
}

const HOUR = 60 * 60 * 1000;

export function registerDiscoverRoutes(app: Express, deps: DiscoverDeps) {
  const { requireAuth, limited, ip, priceItems } = deps;

  /** Public routes: a valid token personalises the response, a missing or bogus one is simply anonymous. */
  const optionalAuth = async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = req.headers["x-auth-token"] as string | undefined;
      if (token) {
        const user = await storage.getUserByToken(token);
        if (user) (req as MaybeAuthedRequest).user = user;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
  const viewerOf = (req: Request): User | undefined => (req as MaybeAuthedRequest).user;
  const adminViewer = (req: Request): boolean => {
    const u = viewerOf(req);
    return !!u && isAdmin(u);
  };
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    if (!isAdmin((req as AuthedRequest).user)) return res.status(403).json({ message: "Admins only" });
    next();
  };
  const noStore = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

  /** Post lookup for public reads: 404 unless active, or the viewer owns it / is an admin. */
  const visiblePost = async (req: Request, res: Response) => {
    const post = await storage.getPost(Number(req.params.id));
    const viewer = viewerOf(req);
    const privileged = !!viewer && (viewer.id === post?.userId || isAdmin(viewer));
    if (!post || (post.status !== "active" && !privileged)) {
      res.status(404).json({ message: "Post not found" });
      return null;
    }
    return post;
  };

  // ---------- share / unshare ----------
  app.post("/api/picks/:id/share", requireAuth, noStore, wrap(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const pick = await storage.getPick(Number(req.params.id));
    if (!pick) return res.status(404).json({ message: "Pick not found" });
    if (pick.userId !== user.id) return res.status(403).json({ message: "Only the owner can share this pick" });
    const body = sharePostBodySchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ message: body.error.issues[0]?.message ?? "Invalid" });
    const photos = await storage.photosForPick(pick.id);
    if (body.data.photoIds) {
      const known = new Set(photos.map((p) => p.id));
      const bad = body.data.photoIds.find((id) => !known.has(id));
      if (bad !== undefined) return res.status(400).json({ message: "photoIds must be photos of this pick", photoId: bad });
    }
    if (limited(`share:${user.id}`, SHARES_PER_USER_PER_HOUR, HOUR)) return res.status(429).json({ message: "Too many shares. Try again in a bit." });
    const post = await storage.upsertPost({
      pickId: pick.id,
      userId: user.id,
      caption: body.data.caption?.trim() || null,
      vibe: body.data.vibe,
      photoIds: body.data.photoIds,
    });
    const view = await storage.postView(post, user, { admin: isAdmin(user) });
    res.status(201).json(view);
  }));

  app.delete("/api/posts/:id", requireAuth, noStore, wrap(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const post = await storage.getPost(Number(req.params.id));
    if (!post || post.status === "removed") return res.status(404).json({ message: "Post not found" });
    const admin = isAdmin(user);
    if (post.userId !== user.id && !admin) return res.status(403).json({ message: "Only the owner can remove this post" });
    const updated = await storage.setPostStatus(post.id, "removed", post.userId === user.id ? "owner" : "admin");
    if (updated && post.userId !== user.id) console.log(`[discover] admin @${user.handle} removed post ${post.id} (author ${post.userId})`);
    res.json({ ok: true, id: post.id, status: updated?.status ?? "removed" });
  }));

  // ---------- public feed ----------
  app.get("/api/discover", optionalAuth, noStore, wrap(async (req, res) => {
    const sortRaw = typeof req.query.sort === "string" && req.query.sort ? req.query.sort : "new";
    if (!(DISCOVER_SORTS as readonly string[]).includes(sortRaw)) return res.status(400).json({ message: "sort must be new or top" });
    const vibeRaw = typeof req.query.vibe === "string" && req.query.vibe ? req.query.vibe : undefined;
    if (vibeRaw && !(POST_VIBES as readonly string[]).includes(vibeRaw)) return res.status(400).json({ message: `vibe must be one of ${POST_VIBES.join(", ")}` });
    const cursor = decodeCursor(req.query.cursor);
    if (cursor === null) return res.status(400).json({ message: "Bad cursor" });
    const { rows, nextCursor } = await storage.listDiscover({ sort: sortRaw as DiscoverSort, vibe: vibeRaw as PostVibe | undefined, cursor });
    const viewer = viewerOf(req);
    res.json({ posts: await storage.postViews(rows, viewer, { admin: adminViewer(req) }), nextCursor });
  }));

  app.get("/api/posts/:id", optionalAuth, noStore, wrap(async (req, res) => {
    const post = await visiblePost(req, res);
    if (!post) return;
    const view = await storage.postView(post, viewerOf(req), { admin: adminViewer(req) });
    if (!view) return res.status(404).json({ message: "Post not found" });
    res.json(view);
  }));

  // Public shopping: the exact pipeline of GET /api/picks/:id/prices (same budget, same 24h cache keyed by the hinted
  // query) applied to the post's pick. The PickView is only used server-side; the response is { postId, items }.
  app.get("/api/posts/:id/prices", optionalAuth, wrap(async (req, res) => {
    const post = await visiblePost(req, res);
    if (!post) return;
    if (limited(`post-prices:${ip(req)}`, POST_PRICES_PER_IP_PER_HOUR, HOUR)) return res.status(429).json({ message: "Slow down a little." });
    const pick = await storage.getPick(post.pickId);
    if (!pick) return res.status(404).json({ message: "Post not found" });
    const view = await storage.pickView(pick);
    res.json({ postId: post.id, items: await priceItems(view) });
  }));

  // ---------- likes ----------
  app.post("/api/posts/:id/like", requireAuth, noStore, wrap(async (req, res) => {
    const user = (req as AuthedRequest).user;
    const post = await storage.getPost(Number(req.params.id));
    if (!post || post.status !== "active") return res.status(404).json({ message: "Post not found" });
    if (limited(`like:${user.id}`, LIKES_PER_USER_PER_HOUR, HOUR)) return res.status(429).json({ message: "Slow down a little." });
    res.json(await storage.toggleLike(post.id, user.id));
  }));

  // ---------- reports ----------
  app.post("/api/posts/:id/report", optionalAuth, noStore, wrap(async (req, res) => {
    const post = await storage.getPost(Number(req.params.id));
    if (!post || post.status === "removed") return res.status(404).json({ message: "Post not found" });
    const body = postReportBodySchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ message: body.error.issues[0]?.message ?? "Invalid" });
    const viewer = viewerOf(req);
    if (viewer && viewer.id === post.userId) return res.status(400).json({ message: "You can't report your own post - delete it instead" });
    if (limited(`post-report:${ip(req)}`, POST_REPORTS_PER_IP_PER_HOUR, HOUR)) return res.status(429).json({ message: "Too many reports from this network. Try again later." });
    const reporterKey = viewer ? `u:${viewer.id}` : `ip:${ip(req)}`;
    const { report, reportCount, autoHidden } = await storage.addReport({ postId: post.id, userId: viewer?.id ?? null, reporterKey, reason: body.data.reason });
    if (autoHidden) console.log(`[discover] post ${post.id} auto-hidden after ${reportCount} distinct reports (latest: ${JSON.stringify(body.data.reason.slice(0, 80))})`);
    res.status(201).json({ id: report.id, reportCount, hidden: autoHidden || post.status === "hidden" });
  }));

  // ---------- profiles / follows ----------
  const userByHandleParam = async (req: Request, res: Response) => {
    const handle = String(req.params.handle || "").replace(/^@/, "").toLowerCase();
    const u = /^[a-z0-9_]{2,20}$/.test(handle) ? await storage.getUserByHandle(handle) : undefined;
    if (!u) {
      res.status(404).json({ message: "No one with that handle" });
      return null;
    }
    return u;
  };

  app.get("/api/users/:handle", optionalAuth, noStore, wrap(async (req, res) => {
    const u = await userByHandleParam(req, res);
    if (!u) return;
    res.json(await storage.publicProfile(u, viewerOf(req)));
  }));

  app.get("/api/users/:handle/posts", optionalAuth, noStore, wrap(async (req, res) => {
    const u = await userByHandleParam(req, res);
    if (!u) return;
    const cursor = decodeCursor(req.query.cursor);
    if (cursor === null) return res.status(400).json({ message: "Bad cursor" });
    const viewer = viewerOf(req);
    const privileged = !!viewer && (viewer.id === u.id || isAdmin(viewer));
    const { rows, nextCursor } = await storage.listUserPosts(u.id, { cursor, includeHidden: privileged });
    res.json({ posts: await storage.postViews(rows, viewer, { admin: adminViewer(req) }), nextCursor });
  }));

  app.post("/api/users/:handle/follow", requireAuth, noStore, wrap(async (req, res) => {
    const me = (req as AuthedRequest).user;
    const u = await userByHandleParam(req, res);
    if (!u) return;
    if (u.id === me.id) return res.status(400).json({ message: "You can't follow yourself" });
    if (limited(`follow:${me.id}`, FOLLOWS_PER_USER_PER_HOUR, HOUR)) return res.status(429).json({ message: "Slow down a little." });
    res.json(await storage.toggleFollow(me.id, u.id));
  }));

  // ---------- admin moderation ----------
  app.get("/api/admin/posts", requireAuth, requireAdmin, noStore, wrap(async (req, res) => {
    const statusRaw = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
    if (statusRaw && !(POST_STATUSES as readonly string[]).includes(statusRaw)) return res.status(400).json({ message: "status must be active, hidden or removed" });
    const rows = await storage.adminListPosts(statusRaw as PostStatus | undefined);
    const views = await storage.postViews(rows, (req as AuthedRequest).user, { admin: true });
    const byId = new Map(rows.map((r) => [r.id, r]));
    res.json(views.map((v) => ({ ...v, reportCount: byId.get(v.id)?.reportCount ?? 0, statusReason: byId.get(v.id)?.statusReason ?? null })));
  }));

  app.patch("/api/admin/posts/:id", requireAuth, requireAdmin, noStore, wrap(async (req, res) => {
    const post = await storage.getPost(Number(req.params.id));
    if (!post) return res.status(404).json({ message: "Post not found" });
    const body = postStatusSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ message: body.error.issues[0]?.message ?? "Invalid" });
    const updated = await storage.setPostStatus(post.id, body.data.status, "admin");
    console.log(`[discover] admin @${(req as AuthedRequest).user.handle} set post ${post.id} ${post.status} -> ${body.data.status}`);
    const view = updated && (await storage.postView(updated, (req as AuthedRequest).user, { admin: true }));
    if (!view) return res.status(404).json({ message: "Post not found" });
    res.json({ ...view, statusReason: updated.statusReason ?? null });
  }));

  app.get("/api/admin/reports", requireAuth, requireAdmin, noStore, wrap(async (_req, res) => {
    res.json(await storage.listReports());
  }));
}
