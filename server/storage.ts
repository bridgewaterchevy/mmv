import {
  users,
  crews,
  crewMembers,
  sessions,
  picks,
  reactions,
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
  Reaction,
  ReactionView,
  GarmentItem,
  ShopFor,
} from "@shared/schema";
import { and, eq, inArray, desc, asc, count, gte } from "drizzle-orm";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
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
  async updateUser(id: number, data: { shopFor?: ShopFor | null }): Promise<User> {
    const db = await getDb();
    const set: Partial<typeof users.$inferInsert> = {};
    if (data.shopFor !== undefined) set.shopFor = data.shopFor;
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
    const views = await Promise.all(rows.map((p) => this.pickView(p, members)));
    return { ...s, crew, members, picks: views };
  }

  // ----- picks -----
  async pickView(p: Pick, members?: PublicUser[]): Promise<PickView> {
    const db = await getDb();
    const user = members?.find((m) => m.id === p.userId) ?? (await this.getUsers([p.userId]))[0];
    const rx = await db.select().from(reactions).where(eq(reactions.pickId, p.id)).orderBy(asc(reactions.id));
    const rxUsers = await this.getUsers(Array.from(new Set(rx.map((r) => r.userId))));
    const reactionViews: ReactionView[] = rx.map((r) => ({ ...r, user: rxUsers.find((u) => u.id === r.userId)! }));
    return {
      ...p,
      palette: safeJson<string[]>(p.palette, []),
      // Read-time decoration, so stored picks never need re-processing:
      //   1. department hint from the pick OWNER's shopFor (else the garment's `fit`) → shoppingQuery +
      //      hinted Compare prices / Amazon links (server/prices.ts applyShoppingHints)
      //   2. affiliate wrapping (server/affiliate.ts), after the urls are final.
      items: wrapItems(applyShoppingHints(safeJson<GarmentItem[]>(p.items, []), user)),
      user,
      reactions: reactionViews,
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
  async upsertPick(data: { sessionId: number; userId: number; photoPath: string; note?: string | null; palette: string[]; items: GarmentItem[] }): Promise<Pick> {
    const db = await getDb();
    const existing = await this.getPickForUser(data.sessionId, data.userId);
    const values = {
      photoPath: data.photoPath,
      note: data.note ?? null,
      palette: JSON.stringify(data.palette),
      items: JSON.stringify(data.items),
      locked: false,
      createdAt: new Date().toISOString(),
    };
    if (existing) {
      await db.delete(reactions).where(eq(reactions.pickId, existing.id));
      const [row] = await db.update(picks).set(values).where(eq(picks.id, existing.id)).returning();
      return row;
    }
    const [row] = await db.insert(picks).values({ sessionId: data.sessionId, userId: data.userId, ...values }).returning();
    return row;
  }
  async setLocked(pickId: number, locked: boolean): Promise<Pick> {
    const db = await getDb();
    const [row] = await db.update(picks).set({ locked }).where(eq(picks.id, pickId)).returning();
    return row;
  }
  async deletePick(pickId: number): Promise<void> {
    const db = await getDb();
    await db.delete(reactions).where(eq(reactions.pickId, pickId));
    await db.delete(picks).where(eq(picks.id, pickId));
  }
  async picksForUser(userId: number): Promise<(PickView & { session: Session; crew: Crew })[]> {
    const db = await getDb();
    const rows = await db.select().from(picks).where(eq(picks.userId, userId)).orderBy(desc(picks.id));
    if (rows.length === 0) return [];
    const sessionRows = await db.select().from(sessions).where(inArray(sessions.id, Array.from(new Set(rows.map((p) => p.sessionId)))));
    const sessionById = new Map(sessionRows.map((s) => [s.id, s]));
    const crewRows = await db.select().from(crews).where(inArray(crews.id, Array.from(new Set(sessionRows.map((s) => s.crewId)))));
    const crewById = new Map(crewRows.map((c) => [c.id, c]));
    const out: (PickView & { session: Session; crew: Crew })[] = [];
    for (const p of rows) {
      const session = sessionById.get(p.sessionId);
      const crew = session ? crewById.get(session.crewId) : undefined;
      if (!session || !crew) continue;
      out.push({ ...(await this.pickView(p)), session, crew });
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
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export const storage = new DatabaseStorage();
