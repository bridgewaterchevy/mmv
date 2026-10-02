import {
  users,
  crews,
  crewMembers,
  sessions,
  picks,
  pickPhotos,
  reactions,
  feedback,
  posts,
  postLikes,
  follows,
  postReports,
  DISCOVER_PAGE_SIZE,
  DISCOVER_TOP_WINDOW_DAYS,
  POST_REPORTS_TO_HIDE,
} from "@shared/schema";
import type {
  User,
  PublicUser,
  Crew,
  CrewView,
  Session,
  SessionView,
  Pick,
  PickView,
  PickPhoto,
  PickPhotoView,
  Reaction,
  ReactionView,
  GarmentItem,
  ShopFor,
  AnalysisStatus,
  Feedback,
  FeedbackReport,
  FeedbackStatus,
  FeedbackKind,
  Post,
  PostView,
  PostVibe,
  PostStatus,
  PostStatusReason,
  PostReport,
  PostReportView,
  DiscoverSort,
  PublicProfile,
} from "@shared/schema";
import { and, eq, inArray, desc, asc, count, gte, lt, sql, ne } from "drizzle-orm";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import type { Db } from "./db";
import { aggregatePhotos } from "./aggregate";
import { wrapItems } from "./affiliate";
import { applyShoppingHints } from "./prices";

export { getDb } from "./db";

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(pin, salt, 32).toString("hex")}`;
}
export function verifyPin(pin: string, stored: string): boolean {
  if (!stored.startsWith("scrypt$")) return false;
  const [, salt, hash] = stored.split("$");
  const candidate = scryptSync(pin, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

const AVATAR_COLORS = [
  "#E8467C", "#F2994A", "#27AE60", "#2D9CDB", "#9B51E0", "#F2C94C", "#EB5757", "#219653",
];

export function toPublic(u: User): PublicUser {
  const { pin: _p, token: _t, ...rest } = u;
  return rest;
}

/** Public display name: the first name only ("Sam Lee-Jones" → "Sam"). Falls back to the handle when blank. */
export function firstName(u: { name: string; handle: string }): string {
  const first = (u.name ?? "").trim().split(/\s+/)[0] ?? "";
  return first || u.handle;
}

// ---- opaque keyset cursors for the Discover feeds ----
export interface FeedCursor {
  t: number; // created_at epoch ms
  i: number; // post id
  l?: number; // like_count (sort=top only)
}
export function encodeCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}
/** undefined for a missing/blank cursor; null when it is malformed (callers answer 400). */
export function decodeCursor(raw: unknown): FeedCursor | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 200) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<FeedCursor>;
    if (!c || !Number.isFinite(c.t) || !Number.isInteger(c.i)) return null;
    if (c.l !== undefined && !Number.isInteger(c.l)) return null;
    return { t: Number(c.t), i: Number(c.i), ...(c.l !== undefined ? { l: Number(c.l) } : {}) };
  } catch {
    return null;
  }
}

function code(len: number) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export class DatabaseStorage {
  // ----- users -----
  async getUserByToken(token: string): Promise<User | undefined> {
    const db = await getDb();
    const [row] = await db.select().from(users).where(eq(users.token, token)).limit(1);
    return row;
  }
  async getUserByHandle(handle: string): Promise<User | undefined> {
    const db = await getDb();
    const [row] = await db.select().from(users).where(eq(users.handle, handle.toLowerCase())).limit(1);
    return row;
  }
  async getUsers(ids: number[]): Promise<PublicUser[]> {
    if (ids.length === 0) return [];
    const db = await getDb();
    const rows = await db.select().from(users).where(inArray(users.id, ids));
    return rows.map(toPublic);
  }
  async createUser(data: { name: string; handle: string; pin: string; shopFor?: ShopFor | null }): Promise<User> {
    const db = await getDb();
    const [{ value: n }] = await db.select({ value: count() }).from(users);
    const [row] = await db
      .insert(users)
      .values({
        name: data.name.trim(),
        handle: data.handle.toLowerCase().trim(),
        pin: hashPin(data.pin),
        color: AVATAR_COLORS[Number(n) % AVATAR_COLORS.length],
        token: code(24),
        shopFor: data.shopFor ?? null,
      })
      .returning();
    return row;
  }
  async getUserById(id: number): Promise<User | undefined> {
    if (!Number.isInteger(id)) return undefined;
    const db = await getDb();
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return row;
  }
  async updateUser(id: number, data: { shopFor?: ShopFor | null; bio?: string | null }): Promise<User> {
    const db = await getDb();
    const set: Partial<typeof users.$inferInsert> = {};
    if (data.shopFor !== undefined) set.shopFor = data.shopFor;
    if (data.bio !== undefined) set.bio = data.bio?.trim() || null;
    if (Object.keys(set).length === 0) {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row;
    }
    const [row] = await db.update(users).set(set).where(eq(users.id, id)).returning();
    return row;
  }

  // ----- crews -----
  async createCrew(data: { name: string; activity: string }, userId: number): Promise<Crew> {
    const db = await getDb();
    const [crew] = await db
      .insert(crews)
      .values({ name: data.name.trim(), activity: data.activity, inviteCode: code(6), createdBy: userId })
      .returning();
    await db.insert(crewMembers).values({ crewId: crew.id, userId });
    return crew;
  }
  async getCrew(id: number): Promise<Crew | undefined> {
    if (!Number.isInteger(id)) return undefined;
    const db = await getDb();
    const [row] = await db.select().from(crews).where(eq(crews.id, id)).limit(1);
    return row;
  }
  async getCrewByInvite(inviteCode: string): Promise<Crew | undefined> {
    const db = await getDb();
    const [row] = await db.select().from(crews).where(eq(crews.inviteCode, inviteCode.toUpperCase())).limit(1);
    return row;
  }
  async isMember(crewId: number, userId: number): Promise<boolean> {
    const db = await getDb();
    const [row] = await db
      .select({ id: crewMembers.id })
      .from(crewMembers)
      .where(and(eq(crewMembers.crewId, crewId), eq(crewMembers.userId, userId)))
      .limit(1);
    return !!row;
  }
  async joinCrew(crewId: number, userId: number): Promise<void> {
    const db = await getDb();
    if (!(await this.isMember(crewId, userId))) await db.insert(crewMembers).values({ crewId, userId });
  }
  async crewMemberIds(crewId: number): Promise<number[]> {
    const db = await getDb();
    const rows = await db.select({ userId: crewMembers.userId }).from(crewMembers).where(eq(crewMembers.crewId, crewId)).orderBy(asc(crewMembers.id));
    return rows.map((m) => m.userId);
  }
  async crewsForUser(userId: number): Promise<CrewView[]> {
    const db = await getDb();
    const memberships = await db.select({ crewId: crewMembers.crewId }).from(crewMembers).where(eq(crewMembers.userId, userId));
    const ids = memberships.map((m) => m.crewId);
    if (ids.length === 0) return [];
    const rows = await db.select().from(crews).where(inArray(crews.id, ids)).orderBy(asc(crews.id));
    return Promise.all(rows.map((c) => this.crewView(c)));
  }
  async crewView(c: Crew): Promise<CrewView> {
    const db = await getDb();
    const members = await this.getUsers(await this.crewMemberIds(c.id));
    const today = new Date().toISOString().slice(0, 10);
    const [next] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.crewId, c.id), gte(sessions.date, today)))
      .orderBy(asc(sessions.date), desc(sessions.id))
      .limit(1);
    const pickCount = next ? await this.countPicks(next.id) : 0;
    return { ...c, members, nextSession: next ? { ...next, pickCount } : null };
  }
  private async countPicks(sessionId: number): Promise<number> {
    const db = await getDb();
    const [{ value }] = await db.select({ value: count() }).from(picks).where(eq(picks.sessionId, sessionId));
    return Number(value);
  }

  // ----- sessions -----
  async createSession(data: { crewId: number; title: string; date: string; vibe?: string | null }, userId: number): Promise<Session> {
    const db = await getDb();
    const [row] = await db
      .insert(sessions)
      .values({ crewId: data.crewId, title: data.title.trim(), date: data.date, vibe: data.vibe?.trim() || null, createdBy: userId })
      .returning();
    return row;
  }
  async getOrCreateDay(crewId: number, date: string, userId: number): Promise<Session> {
    const db = await getDb();
    const [existing] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.crewId, crewId), eq(sessions.date, date)))
      .orderBy(asc(sessions.id))
      .limit(1);
    if (existing) return existing;
    const crew = (await this.getCrew(crewId))!;
    const [row] = await db.insert(sessions).values({ crewId, title: crew.name, date, vibe: null, createdBy: userId }).returning();
    return row;
  }
  async updateSession(id: number, data: { title?: string; vibe?: string | null }): Promise<Session> {
    const db = await getDb();
    if (Object.keys(data).length === 0) return (await this.getSession(id))!;
    const [row] = await db.update(sessions).set(data).where(eq(sessions.id, id)).returning();
    return row;
  }
  async getSession(id: number): Promise<Session | undefined> {
    if (!Number.isInteger(id)) return undefined;
    const db = await getDb();
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    return row;
  }
  async sessionsForCrew(crewId: number): Promise<(Session & { pickCount: number })[]> {
    const db = await getDb();
    const rows = await db.select().from(sessions).where(eq(sessions.crewId, crewId)).orderBy(desc(sessions.date), desc(sessions.id));
    if (rows.length === 0) return [];
    const counts = await db
      .select({ sessionId: picks.sessionId, value: count() })
      .from(picks)
      .where(inArray(picks.sessionId, rows.map((s) => s.id)))
      .groupBy(picks.sessionId);
    const byId = new Map(counts.map((c) => [c.sessionId, Number(c.value)]));
    return rows.map((s) => ({ ...s, pickCount: byId.get(s.id) ?? 0 }));
  }
  async sessionView(s: Session): Promise<SessionView> {
    const db = await getDb();
    const crew = (await this.getCrew(s.crewId))!;
    const members = await this.getUsers(await this.crewMemberIds(s.crewId));
    const rows = await db.select().from(picks).where(eq(picks.sessionId, s.id)).orderBy(asc(picks.id));
    const photosById = await this.photosForPicks(rows.map((p) => p.id));
    const views = await Promise.all(rows.map((p) => this.pickView(p, members, photosById.get(p.id) ?? [])));
    return { ...s, crew, members, picks: views };
  }

  // ----- picks -----
  /** Photos of one pick, position order. */
  async photosForPick(pickId: number): Promise<PickPhoto[]> {
    const db = await getDb();
    return db.select().from(pickPhotos).where(eq(pickPhotos.pickId, pickId)).orderBy(asc(pickPhotos.position), asc(pickPhotos.id));
  }
  /** Photos of many picks in one query, grouped by pick id (position order within a pick). */
  async photosForPicks(pickIds: number[]): Promise<Map<number, PickPhoto[]>> {
    const out = new Map<number, PickPhoto[]>();
    if (pickIds.length === 0) return out;
    const db = await getDb();
    const rows = await db
      .select()
      .from(pickPhotos)
      .where(inArray(pickPhotos.pickId, pickIds))
      .orderBy(asc(pickPhotos.pickId), asc(pickPhotos.position), asc(pickPhotos.id));
    for (const r of rows) {
      const list = out.get(r.pickId);
      if (list) list.push(r);
      else out.set(r.pickId, [r]);
    }
    return out;
  }
  async getPhoto(photoId: number): Promise<PickPhoto | undefined> {
    if (!Number.isInteger(photoId)) return undefined;
    const db = await getDb();
    const [row] = await db.select().from(pickPhotos).where(eq(pickPhotos.id, photoId)).limit(1);
    return row;
  }

  /**
   * PickView = picks row + photos[] + aggregates computed from the photo rows (items merged/deduped, palette merged,
   * status pending > ready > failed; see server/aggregate.ts). `note` is the owner's text, else the first ready
   * photo's summary. `photoPath` is the cover (position 0). Pass `photos` to avoid a query per pick in list views.
   */
  async pickView(p: Pick, members?: PublicUser[], photos?: PickPhoto[]): Promise<PickView> {
    const db = await getDb();
    const user = members?.find((m) => m.id === p.userId) ?? (await this.getUsers([p.userId]))[0];
    const rx = await db.select().from(reactions).where(eq(reactions.pickId, p.id)).orderBy(asc(reactions.id));
    const rxUsers = await this.getUsers(Array.from(new Set(rx.map((r) => r.userId))));
    const reactionViews: ReactionView[] = rx.map((r) => ({ ...r, user: rxUsers.find((u) => u.id === r.userId)! }));
    const photoRows = photos ?? (await this.photosForPick(p.id));
    const agg = aggregateFor(p, photoRows);
    const photoViews: PickPhotoView[] = photoRows.map((ph) => ({
      id: ph.id,
      url: ph.path,
      position: ph.position,
      analysisStatus: ph.analysisStatus,
      analysisError: ph.analysisError ?? null,
      itemCount: Array.isArray(ph.items) ? ph.items.length : 0,
    }));
    return {
      ...p,
      photoPath: agg.coverPath ?? p.photoPath,
      note: p.note || agg.summary || null,
      palette: agg.palette,
      // Read-time decoration, so stored picks never need re-processing:
      //   1. department hint from the pick OWNER's shopFor (else the garment's `fit`) → shoppingQuery +
      //      hinted Compare prices / Amazon links (server/prices.ts applyShoppingHints)
      //   2. affiliate wrapping (server/affiliate.ts), after the urls are final.
      items: wrapItems(applyShoppingHints(agg.items, user)),
      analysisStatus: agg.analysisStatus,
      analysisError: agg.analysisError,
      analyzedAt: agg.analyzedAt,
      user,
      reactions: reactionViews,
      analysisFailed: agg.analysisStatus === "failed",
      photos: photoViews,
    };
  }
  async getPickForUser(sessionId: number, userId: number): Promise<Pick | undefined> {
    const db = await getDb();
    const [row] = await db
      .select()
      .from(picks)
      .where(and(eq(picks.sessionId, sessionId), eq(picks.userId, userId)))
      .orderBy(asc(picks.id))
      .limit(1);
    return row;
  }
  async getPick(id: number): Promise<Pick | undefined> {
    if (!Number.isInteger(id)) return undefined;
    const db = await getDb();
    const [row] = await db.select().from(picks).where(eq(picks.id, id)).limit(1);
    return row;
  }
  /**
   * Create (or, for the same user+session, replace) a pick with 1..N photos. Re-posting deletes the previous
   * photos and reactions; the caller removes the old files. Photos start "pending" (analysed in the background)
   * unless `analysisStatus` says otherwise. Returns the row and the new photo rows (position order).
   */
  async upsertPick(data: {
    sessionId: number;
    userId: number;
    photoPaths: string[];
    note?: string | null;
    /** Defaults to "pending". Tests/legacy callers may pass "ready" with items/palette for every photo. */
    analysisStatus?: AnalysisStatus;
    palette?: string[];
    items?: GarmentItem[];
  }): Promise<{ pick: Pick; photos: PickPhoto[]; previousPhotoPaths: string[] }> {
    const db = await getDb();
    if (data.photoPaths.length === 0) throw new Error("upsertPick needs at least one photo");
    const existing = await this.getPickForUser(data.sessionId, data.userId);
    const status = data.analysisStatus ?? "pending";
    const now = new Date();
    const values = {
      photoPath: data.photoPaths[0],
      note: data.note ?? null,
      palette: JSON.stringify(data.palette ?? []),
      items: JSON.stringify(data.items ?? []),
      locked: false,
      createdAt: now.toISOString(),
      analysisStatus: status,
      analysisError: null,
      analyzedAt: status === "ready" ? now : null,
    };
    return db.transaction(async (tx) => {
      let pick: Pick;
      let previousPhotoPaths: string[] = [];
      if (existing) {
        const old = await tx.select({ path: pickPhotos.path }).from(pickPhotos).where(eq(pickPhotos.pickId, existing.id));
        previousPhotoPaths = old.map((o) => o.path);
        if (previousPhotoPaths.length === 0 && existing.photoPath) previousPhotoPaths = [existing.photoPath];
        await tx.delete(reactions).where(eq(reactions.pickId, existing.id));
        await tx.delete(pickPhotos).where(eq(pickPhotos.pickId, existing.id));
        [pick] = await tx.update(picks).set(values).where(eq(picks.id, existing.id)).returning();
      } else {
        [pick] = await tx.insert(picks).values({ sessionId: data.sessionId, userId: data.userId, ...values }).returning();
      }
      const photos = await tx
        .insert(pickPhotos)
        .values(
          data.photoPaths.map((path, i) => ({
            pickId: pick.id,
            path,
            position: i,
            analysisStatus: status,
            analysisError: null,
            items: i === 0 ? data.items ?? [] : [],
            palette: i === 0 ? data.palette ?? [] : [],
            summary: null,
            analyzedAt: status === "ready" ? now : null,
            createdAt: now,
          })),
        )
        .returning();
      photos.sort((a, b) => a.position - b.position);
      // A re-post replaces every photo, so a public post of this pick loses all its chosen photos → hidden until re-shared.
      if (existing) await this.syncPostPhotos(pick.id, tx);
      return { pick, photos, previousPhotoPaths };
    });
  }
  /** Append photos to an existing pick (positions continue after the current last). Caller enforces the max. */
  async addPhotos(pickId: number, paths: string[]): Promise<PickPhoto[]> {
    if (paths.length === 0) return [];
    const db = await getDb();
    const now = new Date();
    return db.transaction(async (tx) => {
      const current = await tx.select({ position: pickPhotos.position }).from(pickPhotos).where(eq(pickPhotos.pickId, pickId));
      const start = current.length ? Math.max(...current.map((c) => c.position)) + 1 : 0;
      const rows = await tx
        .insert(pickPhotos)
        .values(paths.map((path, i) => ({ pickId, path, position: start + i, analysisStatus: "pending" as const, items: [], palette: [], createdAt: now })))
        .returning();
      await this.recomputePickAggregates(pickId, tx);
      return rows.sort((a, b) => a.position - b.position);
    });
  }
  /**
   * Remove one photo, renumber the rest (0..n-1, keeping their order) and recompute the aggregates. Returns the
   * removed row (caller deletes the file) or undefined when it does not belong to the pick. Refuses (returns
   * { last: true }) when it is the only photo: delete the pick instead.
   */
  async deletePhoto(pickId: number, photoId: number): Promise<{ removed?: PickPhoto; last?: boolean }> {
    const db = await getDb();
    return db.transaction(async (tx) => {
      const rows = await tx.select().from(pickPhotos).where(eq(pickPhotos.pickId, pickId)).orderBy(asc(pickPhotos.position), asc(pickPhotos.id));
      const target = rows.find((r) => r.id === photoId);
      if (!target) return {};
      if (rows.length <= 1) return { last: true };
      await tx.delete(pickPhotos).where(eq(pickPhotos.id, photoId));
      const rest = rows.filter((r) => r.id !== photoId);
      for (let i = 0; i < rest.length; i++) {
        if (rest[i].position !== i) await tx.update(pickPhotos).set({ position: i }).where(eq(pickPhotos.id, rest[i].id));
      }
      await this.recomputePickAggregates(pickId, tx);
      await this.syncPostPhotos(pickId, tx);
      return { removed: target };
    });
  }
  /**
   * Mark photos as queued for (re-)analysis and refresh the pick aggregate. Items/palette on the photo are kept
   * until the new result lands so the crew keeps seeing the previous pieces while a retry runs.
   */
  async markPhotosPending(pickId: number, photoIds: number[]): Promise<PickPhoto[]> {
    if (photoIds.length === 0) return [];
    const db = await getDb();
    return db.transaction(async (tx) => {
      const rows = await tx
        .update(pickPhotos)
        .set({ analysisStatus: "pending", analysisError: null })
        .where(and(eq(pickPhotos.pickId, pickId), inArray(pickPhotos.id, photoIds)))
        .returning();
      await this.recomputePickAggregates(pickId, tx);
      return rows.sort((a, b) => a.position - b.position);
    });
  }
  /**
   * Store a finished analysis of ONE photo and recompute the pick in the same transaction. Guarded by `path`: if
   * the row has moved on (photo deleted / replaced) the stale result is dropped and undefined is returned.
   */
  async completePhotoAnalysis(photoId: number, path: string, result: { palette: string[]; items: GarmentItem[]; summary?: string | null }): Promise<PickPhoto | undefined> {
    const db = await getDb();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(pickPhotos)
        .set({ palette: result.palette, items: result.items, summary: result.summary?.trim() || null, analysisStatus: "ready", analysisError: null, analyzedAt: new Date() })
        .where(and(eq(pickPhotos.id, photoId), eq(pickPhotos.path, path)))
        .returning();
      if (!row) return undefined;
      await this.recomputePickAggregates(row.pickId, tx);
      return row;
    });
  }
  /** Record a failed analysis of one photo (same `path` guard). `error` must already be short and secret-free. */
  async failPhotoAnalysis(photoId: number, path: string, error: string): Promise<PickPhoto | undefined> {
    const db = await getDb();
    return db.transaction(async (tx) => {
      const [row] = await tx
        .update(pickPhotos)
        .set({ analysisStatus: "failed", analysisError: error.slice(0, 300), analyzedAt: new Date() })
        .where(and(eq(pickPhotos.id, photoId), eq(pickPhotos.path, path)))
        .returning();
      if (!row) return undefined;
      await this.recomputePickAggregates(row.pickId, tx);
      return row;
    });
  }
  /**
   * Recompute the aggregate columns of a pick from its photo rows (items/palette/status/error/analyzedAt and the
   * cover photo_path). Runs inside the caller's transaction when `tx` is given. No-op for a pick without photos.
   */
  async recomputePickAggregates(pickId: number, tx?: Db): Promise<Pick | undefined> {
    const db = tx ?? (await getDb());
    const photos = await db.select().from(pickPhotos).where(eq(pickPhotos.pickId, pickId)).orderBy(asc(pickPhotos.position), asc(pickPhotos.id));
    if (photos.length === 0) return undefined;
    const agg = aggregatePhotos(photos);
    const [row] = await db
      .update(picks)
      .set({
        photoPath: agg.coverPath ?? undefined,
        items: JSON.stringify(agg.items),
        palette: JSON.stringify(agg.palette),
        analysisStatus: agg.analysisStatus,
        analysisError: agg.analysisError,
        analyzedAt: agg.analyzedAt,
      })
      .where(eq(picks.id, pickId))
      .returning();
    return row;
  }
  /** Photos still "pending" created before `before`; used by startup recovery and the periodic sweep. */
  async stalePendingPhotos(before: Date): Promise<PickPhoto[]> {
    const db = await getDb();
    return db
      .select()
      .from(pickPhotos)
      .where(and(eq(pickPhotos.analysisStatus, "pending"), lt(pickPhotos.createdAt, before)))
      .orderBy(asc(pickPhotos.id))
      .limit(200);
  }
  async setLocked(pickId: number, locked: boolean): Promise<Pick> {
    const db = await getDb();
    const [row] = await db.update(picks).set({ locked }).where(eq(picks.id, pickId)).returning();
    return row;
  }
  /** Delete a pick with its reactions and photo rows; returns the stored photo paths so the caller can remove the files. */
  async deletePick(pickId: number): Promise<string[]> {
    const db = await getDb();
    const photos = await this.photosForPick(pickId);
    const [pick] = await db.select({ photoPath: picks.photoPath }).from(picks).where(eq(picks.id, pickId)).limit(1);
    await db.transaction(async (tx) => {
      await tx.delete(reactions).where(eq(reactions.pickId, pickId));
      await tx.delete(posts).where(eq(posts.pickId, pickId)); // explicit, in addition to the FK cascade (likes/reports cascade from posts)
      await tx.delete(pickPhotos).where(eq(pickPhotos.pickId, pickId)); // explicit, in addition to the FK cascade
      await tx.delete(picks).where(eq(picks.id, pickId));
    });
    const paths = new Set(photos.map((p) => p.path));
    if (pick?.photoPath) paths.add(pick.photoPath);
    return Array.from(paths);
  }
  async picksForUser(userId: number): Promise<(PickView & { session: Session; crew: Crew })[]> {
    const db = await getDb();
    const rows = await db.select().from(picks).where(eq(picks.userId, userId)).orderBy(desc(picks.id));
    if (rows.length === 0) return [];
    const sessionRows = await db.select().from(sessions).where(inArray(sessions.id, Array.from(new Set(rows.map((p) => p.sessionId)))));
    const sessionById = new Map(sessionRows.map((s) => [s.id, s]));
    const crewRows = await db.select().from(crews).where(inArray(crews.id, Array.from(new Set(sessionRows.map((s) => s.crewId)))));
    const crewById = new Map(crewRows.map((c) => [c.id, c]));
    const photosById = await this.photosForPicks(rows.map((p) => p.id));
    const out: (PickView & { session: Session; crew: Crew })[] = [];
    for (const p of rows) {
      const session = sessionById.get(p.sessionId);
      const crew = session ? crewById.get(session.crewId) : undefined;
      if (!session || !crew) continue;
      out.push({ ...(await this.pickView(p, undefined, photosById.get(p.id) ?? [])), session, crew });
    }
    return out;
  }

  // ----- reactions -----
  async addReaction(data: { pickId: number; userId: number; emoji?: string | null; comment?: string | null }): Promise<Reaction> {
    const db = await getDb();
    if (data.emoji) {
      // one emoji per user per pick: toggle
      const [existing] = await db
        .select()
        .from(reactions)
        .where(and(eq(reactions.pickId, data.pickId), eq(reactions.userId, data.userId), eq(reactions.emoji, data.emoji)))
        .limit(1);
      if (existing) {
        await db.delete(reactions).where(eq(reactions.id, existing.id));
        return existing;
      }
    }
    const [row] = await db
      .insert(reactions)
      .values({ pickId: data.pickId, userId: data.userId, emoji: data.emoji ?? null, comment: data.comment ?? null })
      .returning();
    return row;
  }

  // ----- Discover: posts / likes / follows / reports (server/discover.ts) -----
  async getPost(id: number): Promise<Post | undefined> {
    if (!Number.isInteger(id)) return undefined;
    const db = await getDb();
    const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
    return row;
  }
  async getPostByPick(pickId: number): Promise<Post | undefined> {
    const db = await getDb();
    const [row] = await db.select().from(posts).where(eq(posts.pickId, pickId)).limit(1);
    return row;
  }
  /**
   * Create or update the one post of a pick. `photoIds` must already be validated as a subset of the pick's photos
   * (stored in pick position order). A hidden/removed post comes back to "active" unless it was hidden by reports or
   * removed by an admin (sticky reasons) — the caller surfaces `status` so the UI can say "under review".
   */
  async upsertPost(data: { pickId: number; userId: number; caption: string | null; vibe: PostVibe; photoIds?: number[] }): Promise<Post> {
    const db = await getDb();
    const photoRows = await this.photosForPick(data.pickId);
    const order = new Map(photoRows.map((p, i) => [p.id, i]));
    const pickIds = (ids: number[]) => Array.from(new Set(ids.filter((id) => order.has(id)))).sort((a, b) => order.get(a)! - order.get(b)!);
    const existing = await this.getPostByPick(data.pickId);
    const now = new Date();
    if (existing) {
      // photoIds omitted = keep the current selection; when nothing of it survived (photo removed / re-post) fall back to every photo.
      const kept = data.photoIds ? pickIds(data.photoIds) : pickIds(existing.photoIds);
      const photoIds = !data.photoIds && kept.length === 0 ? photoRows.map((p) => p.id) : kept;
      const sticky = existing.status !== "active" && (existing.statusReason === "reports" || existing.statusReason === "admin");
      const status: PostStatus = photoIds.length === 0 ? (sticky ? existing.status : "hidden") : sticky ? existing.status : "active";
      const statusReason: PostStatusReason | null = sticky ? existing.statusReason : photoIds.length === 0 ? "no_photos" : null;
      const [row] = await db
        .update(posts)
        .set({ caption: data.caption, vibe: data.vibe, photoIds, status, statusReason, updatedAt: now })
        .where(eq(posts.id, existing.id))
        .returning();
      return row;
    }
    const photoIds = pickIds(data.photoIds ?? photoRows.map((p) => p.id));
    const [row] = await db
      .insert(posts)
      .values({
        pickId: data.pickId,
        userId: data.userId,
        caption: data.caption,
        vibe: data.vibe,
        photoIds,
        likeCount: 0,
        status: photoIds.length === 0 ? "hidden" : "active",
        statusReason: photoIds.length === 0 ? "no_photos" : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  }
  async setPostStatus(id: number, status: PostStatus, reason: PostStatusReason | null): Promise<Post | undefined> {
    const db = await getDb();
    const [row] = await db
      .update(posts)
      .set({ status, statusReason: status === "active" ? null : reason, updatedAt: new Date() })
      .where(eq(posts.id, id))
      .returning();
    return row;
  }
  /**
   * Keep a post's photo_ids in step with the pick's photos: drop ids that no longer exist; when none are left the
   * post is hidden (reason no_photos). Called inside the photo-delete / re-post transactions.
   */
  async syncPostPhotos(pickId: number, tx?: Db): Promise<void> {
    const db = tx ?? (await getDb());
    const [post] = await db.select().from(posts).where(eq(posts.pickId, pickId)).limit(1);
    if (!post) return;
    const photoRows = await db.select({ id: pickPhotos.id }).from(pickPhotos).where(eq(pickPhotos.pickId, pickId));
    const alive = new Set(photoRows.map((p) => p.id));
    const kept = (post.photoIds ?? []).filter((id) => alive.has(id));
    if (kept.length === (post.photoIds ?? []).length) return;
    const hide = kept.length === 0 && post.status === "active";
    await db
      .update(posts)
      .set({ photoIds: kept, ...(hide ? { status: "hidden" as const, statusReason: "no_photos" as const } : {}), updatedAt: new Date() })
      .where(eq(posts.id, post.id));
    if (hide) console.log(`[discover] post ${post.id} hidden: no public photo left on pick ${pickId}`);
  }

  /** Public feed page. `top` = like_count desc, created desc over the last DISCOVER_TOP_WINDOW_DAYS days; `new` = created desc. */
  async listDiscover(opts: { sort: DiscoverSort; vibe?: PostVibe; cursor?: FeedCursor; limit?: number }): Promise<{ rows: Post[]; nextCursor: string | null }> {
    const db = await getDb();
    const limit = Math.min(50, Math.max(1, opts.limit ?? DISCOVER_PAGE_SIZE));
    const conds = [eq(posts.status, "active")];
    if (opts.vibe) conds.push(eq(posts.vibe, opts.vibe));
    const c = opts.cursor;
    if (opts.sort === "top") {
      conds.push(gte(posts.createdAt, new Date(Date.now() - DISCOVER_TOP_WINDOW_DAYS * 24 * 60 * 60 * 1000)));
      if (c) conds.push(sql`(${posts.likeCount}, ${posts.createdAt}, ${posts.id}) < (${c.l ?? 0}::int, ${new Date(c.t).toISOString()}::timestamptz, ${c.i}::int)`);
    } else if (c) {
      conds.push(sql`(${posts.createdAt}, ${posts.id}) < (${new Date(c.t).toISOString()}::timestamptz, ${c.i}::int)`);
    }
    const order = opts.sort === "top" ? [desc(posts.likeCount), desc(posts.createdAt), desc(posts.id)] : [desc(posts.createdAt), desc(posts.id)];
    const rows = await db
      .select()
      .from(posts)
      .where(and(...conds))
      .orderBy(...order)
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor({ t: last.createdAt.getTime(), i: last.id, ...(opts.sort === "top" ? { l: last.likeCount } : {}) })
        : null;
    return { rows: page, nextCursor };
  }
  /** One user's posts, newest first. `includeHidden` (owner/admin) adds hidden posts; removed ones never show. */
  async listUserPosts(userId: number, opts: { cursor?: FeedCursor; includeHidden?: boolean; limit?: number }): Promise<{ rows: Post[]; nextCursor: string | null }> {
    const db = await getDb();
    const limit = Math.min(50, Math.max(1, opts.limit ?? DISCOVER_PAGE_SIZE));
    const conds = [eq(posts.userId, userId), opts.includeHidden ? ne(posts.status, "removed") : eq(posts.status, "active")];
    if (opts.cursor) conds.push(sql`(${posts.createdAt}, ${posts.id}) < (${new Date(opts.cursor.t).toISOString()}::timestamptz, ${opts.cursor.i}::int)`);
    const rows = await db
      .select()
      .from(posts)
      .where(and(...conds))
      .orderBy(desc(posts.createdAt), desc(posts.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor({ t: last.createdAt.getTime(), i: last.id }) : null };
  }
  /** Admin list: every status (or one), newest first, with the distinct-report count. */
  async adminListPosts(status?: PostStatus, limit = 100): Promise<(Post & { reportCount: number })[]> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(posts)
      .where(status ? eq(posts.status, status) : undefined)
      .orderBy(desc(posts.updatedAt), desc(posts.id))
      .limit(limit);
    if (rows.length === 0) return [];
    const counts = await db
      .select({ postId: postReports.postId, value: count() })
      .from(postReports)
      .where(inArray(postReports.postId, rows.map((r) => r.id)))
      .groupBy(postReports.postId);
    const byId = new Map(counts.map((c) => [c.postId, Number(c.value)]));
    return rows.map((r) => ({ ...r, reportCount: byId.get(r.id) ?? 0 }));
  }

  /**
   * Build PostViews for many posts in a handful of queries. Only public data: chosen photos, aggregated items (decorated
   * like PickView.items), palette, status, first-name author card. `pickId` only for the owner / admins.
   */
  async postViews(rows: Post[], viewer?: User | null, opts: { admin?: boolean } = {}): Promise<PostView[]> {
    if (rows.length === 0) return [];
    const db = await getDb();
    const pickIds = Array.from(new Set(rows.map((r) => r.pickId)));
    const pickRows = await db.select().from(picks).where(inArray(picks.id, pickIds));
    const pickById = new Map(pickRows.map((p) => [p.id, p]));
    const photosById = await this.photosForPicks(pickIds);
    const authorRows = await db.select().from(users).where(inArray(users.id, Array.from(new Set(rows.map((r) => r.userId)))));
    const authorById = new Map(authorRows.map((u) => [u.id, u]));
    const liked = new Set<number>();
    const following = new Set<number>();
    if (viewer) {
      const likes = await db
        .select({ postId: postLikes.postId })
        .from(postLikes)
        .where(and(eq(postLikes.userId, viewer.id), inArray(postLikes.postId, rows.map((r) => r.id))));
      for (const l of likes) liked.add(l.postId);
      const fl = await db
        .select({ followeeId: follows.followeeId })
        .from(follows)
        .where(and(eq(follows.followerId, viewer.id), inArray(follows.followeeId, Array.from(authorById.keys()))));
      for (const f of fl) following.add(f.followeeId);
    }
    const out: PostView[] = [];
    for (const post of rows) {
      const pick = pickById.get(post.pickId);
      const author = authorById.get(post.userId);
      if (!pick || !author) continue; // orphan (pick or user gone) — never surface it
      const photoRows = photosById.get(pick.id) ?? [];
      const agg = aggregateFor(pick, photoRows);
      const chosen = new Set(post.photoIds ?? []);
      const isMine = !!viewer && viewer.id === post.userId;
      out.push({
        id: post.id,
        caption: post.caption,
        vibe: post.vibe,
        createdAt: post.createdAt.toISOString(),
        likeCount: post.likeCount,
        likedByMe: liked.has(post.id),
        photos: photoRows.filter((ph) => chosen.has(ph.id)).map((ph) => ({ id: ph.id, url: ph.path })),
        items: wrapItems(applyShoppingHints(agg.items, author)),
        palette: agg.palette,
        analysisStatus: agg.analysisStatus,
        author: { id: author.id, name: firstName(author), handle: author.handle, color: author.color, isFollowedByMe: following.has(author.id) },
        isMine,
        status: post.status,
        pickId: isMine || opts.admin ? post.pickId : null,
      });
    }
    return out;
  }
  async postView(post: Post, viewer?: User | null, opts: { admin?: boolean } = {}): Promise<PostView | undefined> {
    const [v] = await this.postViews([post], viewer, opts);
    return v;
  }

  async toggleLike(postId: number, userId: number): Promise<{ likeCount: number; likedByMe: boolean }> {
    const db = await getDb();
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: postLikes.id })
        .from(postLikes)
        .where(and(eq(postLikes.postId, postId), eq(postLikes.userId, userId)))
        .limit(1);
      if (existing) await tx.delete(postLikes).where(eq(postLikes.id, existing.id));
      else await tx.insert(postLikes).values({ postId, userId, createdAt: new Date() });
      const [{ value }] = await tx.select({ value: count() }).from(postLikes).where(eq(postLikes.postId, postId));
      const likeCount = Number(value);
      await tx.update(posts).set({ likeCount }).where(eq(posts.id, postId));
      return { likeCount, likedByMe: !existing };
    });
  }
  async toggleFollow(followerId: number, followeeId: number): Promise<{ following: boolean; followerCount: number }> {
    const db = await getDb();
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: follows.id })
        .from(follows)
        .where(and(eq(follows.followerId, followerId), eq(follows.followeeId, followeeId)))
        .limit(1);
      if (existing) await tx.delete(follows).where(eq(follows.id, existing.id));
      else await tx.insert(follows).values({ followerId, followeeId, createdAt: new Date() });
      const [{ value }] = await tx.select({ value: count() }).from(follows).where(eq(follows.followeeId, followeeId));
      return { following: !existing, followerCount: Number(value) };
    });
  }
  async isFollowing(followerId: number, followeeId: number): Promise<boolean> {
    const db = await getDb();
    const [row] = await db
      .select({ id: follows.id })
      .from(follows)
      .where(and(eq(follows.followerId, followerId), eq(follows.followeeId, followeeId)))
      .limit(1);
    return !!row;
  }
  /** followerCount / followingCount / postCount (active posts) for a user. */
  async profileCounts(userId: number): Promise<{ followerCount: number; followingCount: number; postCount: number }> {
    const db = await getDb();
    const [[fr], [fg], [pc]] = await Promise.all([
      db.select({ value: count() }).from(follows).where(eq(follows.followeeId, userId)),
      db.select({ value: count() }).from(follows).where(eq(follows.followerId, userId)),
      db.select({ value: count() }).from(posts).where(and(eq(posts.userId, userId), eq(posts.status, "active"))),
    ]);
    return { followerCount: Number(fr.value), followingCount: Number(fg.value), postCount: Number(pc.value) };
  }
  async publicProfile(u: User, viewer?: User | null): Promise<PublicProfile> {
    const counts = await this.profileCounts(u.id);
    const isMe = !!viewer && viewer.id === u.id;
    return {
      id: u.id,
      name: firstName(u),
      handle: u.handle,
      color: u.color,
      bio: u.bio ?? null,
      ...counts,
      isFollowedByMe: viewer && !isMe ? await this.isFollowing(viewer.id, u.id) : false,
      isMe,
    };
  }

  /**
   * Record a report. One row per (post, reporterKey): a repeat from the same reporter updates the reason instead of
   * counting again. When the distinct count reaches POST_REPORTS_TO_HIDE and the post is active it is auto-hidden.
   */
  async addReport(data: { postId: number; userId: number | null; reporterKey: string; reason: string }): Promise<{ report: PostReport; reportCount: number; autoHidden: boolean }> {
    const db = await getDb();
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(postReports)
        .where(and(eq(postReports.postId, data.postId), eq(postReports.reporterKey, data.reporterKey)))
        .limit(1);
      let report: PostReport;
      if (existing) {
        [report] = await tx.update(postReports).set({ reason: data.reason, userId: data.userId ?? existing.userId }).where(eq(postReports.id, existing.id)).returning();
      } else {
        [report] = await tx
          .insert(postReports)
          .values({ postId: data.postId, userId: data.userId, reporterKey: data.reporterKey, reason: data.reason, createdAt: new Date() })
          .returning();
      }
      const [{ value }] = await tx.select({ value: count() }).from(postReports).where(eq(postReports.postId, data.postId));
      const reportCount = Number(value);
      let autoHidden = false;
      if (reportCount >= POST_REPORTS_TO_HIDE) {
        const [hidden] = await tx
          .update(posts)
          .set({ status: "hidden", statusReason: "reports", updatedAt: new Date() })
          .where(and(eq(posts.id, data.postId), eq(posts.status, "active")))
          .returning({ id: posts.id });
        autoHidden = !!hidden;
      }
      return { report, reportCount, autoHidden };
    });
  }
  /** Admin: newest reports with reporter card and the post's current status. */
  async listReports(limit = 200): Promise<PostReportView[]> {
    const db = await getDb();
    const rows = await db.select().from(postReports).orderBy(desc(postReports.createdAt), desc(postReports.id)).limit(limit);
    if (rows.length === 0) return [];
    const reporterIds = Array.from(new Set(rows.map((r) => r.userId).filter((id): id is number => id !== null)));
    const postRows = await db.select({ id: posts.id, status: posts.status, userId: posts.userId }).from(posts).where(inArray(posts.id, Array.from(new Set(rows.map((r) => r.postId)))));
    const postById = new Map(postRows.map((p) => [p.id, p]));
    const userIds = Array.from(new Set([...reporterIds, ...postRows.map((p) => p.userId)]));
    const people = userIds.length ? await db.select({ id: users.id, name: users.name, handle: users.handle }).from(users).where(inArray(users.id, userIds)) : [];
    const personById = new Map(people.map((u) => [u.id, u]));
    return rows.map((r) => {
      const post = postById.get(r.postId);
      const reporter = r.userId !== null ? personById.get(r.userId) : undefined;
      return {
        ...r,
        reporter: reporter ? { id: reporter.id, name: reporter.name, handle: reporter.handle } : null,
        postStatus: post?.status ?? "removed",
        postAuthorHandle: post ? personById.get(post.userId)?.handle ?? null : null,
      };
    });
  }

  // ----- feedback ("Report a problem" / "Suggest an idea") -----
  async createFeedback(data: {
    userId: number;
    kind?: FeedbackKind;
    message: string;
    page?: string | null;
    userAgent?: string | null;
    appVersion?: string | null;
    lastError?: string | null;
  }): Promise<Feedback> {
    const db = await getDb();
    const [row] = await db
      .insert(feedback)
      .values({
        userId: data.userId,
        kind: data.kind ?? "problem",
        message: data.message,
        page: data.page ?? null,
        userAgent: data.userAgent ?? null,
        appVersion: data.appVersion ?? null,
        lastError: data.lastError ?? null,
        status: "open",
        createdAt: new Date(),
      })
      .returning();
    return row;
  }
  async updateFeedback(id: number, data: { screenshotPath?: string | null; githubIssueUrl?: string | null; status?: FeedbackStatus }): Promise<Feedback> {
    const db = await getDb();
    const set: Partial<typeof feedback.$inferInsert> = {};
    if (data.screenshotPath !== undefined) set.screenshotPath = data.screenshotPath;
    if (data.githubIssueUrl !== undefined) set.githubIssueUrl = data.githubIssueUrl;
    if (data.status !== undefined) set.status = data.status;
    if (Object.keys(set).length === 0) return (await this.getFeedback(id))!;
    const [row] = await db.update(feedback).set(set).where(eq(feedback.id, id)).returning();
    return row;
  }
  async getFeedback(id: number): Promise<Feedback | undefined> {
    if (!Number.isInteger(id)) return undefined;
    const db = await getDb();
    const [row] = await db.select().from(feedback).where(eq(feedback.id, id)).limit(1);
    return row;
  }
  async countFeedbackSince(userId: number, since: Date): Promise<number> {
    const db = await getDb();
    const [{ value }] = await db
      .select({ value: count() })
      .from(feedback)
      .where(and(eq(feedback.userId, userId), gte(feedback.createdAt, since)));
    return Number(value);
  }
  /** Newest first, capped, optionally one kind only. Reporter name/handle attached for the admin list. */
  async listFeedback(limit = 100, kind?: FeedbackKind): Promise<FeedbackReport[]> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(feedback)
      .where(kind ? eq(feedback.kind, kind) : undefined)
      .orderBy(desc(feedback.createdAt), desc(feedback.id))
      .limit(limit);
    if (rows.length === 0) return [];
    const ids = Array.from(new Set(rows.map((r) => r.userId)));
    const people = await db.select({ id: users.id, name: users.name, handle: users.handle }).from(users).where(inArray(users.id, ids));
    const byId = new Map(people.map((u) => [u.id, u]));
    return rows.map((r) => ({ ...r, user: byId.get(r.userId) ?? null }));
  }
}

/**
 * Aggregate a pick from its photo rows (server/aggregate.ts). Legacy safety net: a pick without photo rows
 * (back-fill not run yet) behaves like before from its own columns.
 */
function aggregateFor(p: Pick, photoRows: PickPhoto[]) {
  return photoRows.length > 0
    ? aggregatePhotos(photoRows)
    : {
        items: safeJson<GarmentItem[]>(p.items, []),
        palette: safeJson<string[]>(p.palette, []),
        analysisStatus: p.analysisStatus,
        analysisError: p.analysisError,
        analyzedAt: p.analyzedAt,
        summary: null,
        coverPath: p.photoPath,
      };
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export const storage = new DatabaseStorage();
