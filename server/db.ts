import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import fs from "node:fs";
import path from "node:path";

/**
 * One drizzle instance for the whole server.
 *
 * - DATABASE_URL set  -> real Postgres via postgres-js (Supabase in production).
 *   `prepare: false` is required for Supabase's transaction pooler (port 6543),
 *   which does not support named prepared statements.
 * - DATABASE_URL unset -> embedded Postgres (pglite) persisted under ./data/pglite,
 *   so local dev and tests run fully offline with the same SQL dialect.
 */
export type Db = PgDatabase<PgQueryResultHKT>;

let dbPromise: Promise<Db> | null = null;

export function getDb(): Promise<Db> {
  if (!dbPromise) dbPromise = init();
  return dbPromise;
}

/**
 * Resolve the Postgres URL. Prefer DATABASE_URL; otherwise assemble it from
 * SUPABASE_DB_PASSWORD (+ optional SUPABASE_DB_HOST/USER/PORT) so a non-developer
 * only has to paste the raw password into one field — special characters included.
 */
function resolveDatabaseUrl(): string | undefined {
  const direct = process.env.DATABASE_URL?.trim();
  if (direct && /^postgres(ql)?:\/\//.test(direct) && !direct.includes("[YOUR-PASSWORD]")) return direct;
  if (direct) console.warn("[db] DATABASE_URL is not a valid postgres:// URL; ignoring it");
  const pw = process.env.SUPABASE_DB_PASSWORD?.trim();
  if (!pw) return undefined;
  const user = process.env.SUPABASE_DB_USER?.trim() || "postgres";
  const host = process.env.SUPABASE_DB_HOST?.trim() || "localhost";
  const port = process.env.SUPABASE_DB_PORT?.trim() || "5432";
  const name = process.env.SUPABASE_DB_NAME?.trim() || "postgres";
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pw)}@${host}:${port}/${name}`;
}

async function init(): Promise<Db> {
  const url = resolveDatabaseUrl();
  let db: Db;
  if (url) {
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const postgres = (await import("postgres")).default;
    const client = postgres(url, {
      prepare: false,
      max: Number(process.env.PG_POOL_MAX || 5),
      idle_timeout: 20,
      connect_timeout: 15,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : "require",
    });
    db = drizzle(client) as unknown as Db;
    console.log("[db] using Postgres (DATABASE_URL)");
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const dir = path.resolve(process.env.PGLITE_DIR || "data/pglite");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const client = new PGlite(dir);
    await client.waitReady;
    db = drizzle(client) as unknown as Db;
    console.log(`[db] using pglite at ${dir}`);
  }
  await migrate(db);
  return db;
}

// Idempotent DDL. Runs on every boot for both drivers; no manual migration step.
const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    handle TEXT NOT NULL UNIQUE,
    pin TEXT NOT NULL,
    color TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    shop_for TEXT
  )`,
  // Existing databases (Supabase) created before shop_for existed: add the column in place.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_for TEXT`,
  // Public profile blurb for Discover (PATCH /api/me { bio }).
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`,
  `CREATE TABLE IF NOT EXISTS crews (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    activity TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_by INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS crew_members (
    id SERIAL PRIMARY KEY,
    crew_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS crew_members_crew_idx ON crew_members (crew_id)`,
  `CREATE INDEX IF NOT EXISTS crew_members_user_idx ON crew_members (user_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    crew_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    vibe TEXT,
    created_by INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_crew_date_idx ON sessions (crew_id, date)`,
  `CREATE TABLE IF NOT EXISTS picks (
    id SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    photo_path TEXT NOT NULL,
    note TEXT,
    palette TEXT NOT NULL DEFAULT '[]',
    items TEXT NOT NULL DEFAULT '[]',
    locked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL,
    analysis_status TEXT NOT NULL DEFAULT 'ready',
    analysis_error TEXT,
    analyzed_at TIMESTAMPTZ
  )`,
  // Background outfit analysis (server/analysis.ts). Existing rows were analysed inline at upload -> 'ready'.
  `ALTER TABLE picks ADD COLUMN IF NOT EXISTS analysis_status TEXT NOT NULL DEFAULT 'ready'`,
  `ALTER TABLE picks ADD COLUMN IF NOT EXISTS analysis_error TEXT`,
  `ALTER TABLE picks ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS picks_session_idx ON picks (session_id)`,
  `CREATE INDEX IF NOT EXISTS picks_user_idx ON picks (user_id)`,
  `CREATE INDEX IF NOT EXISTS picks_analysis_status_idx ON picks (analysis_status)`,
  // Several photos per pick (full outfit and/or single pieces); each analysed on its own. The picks row keeps the
  // aggregates (items/palette/status) and photo_path = cover. Legacy picks are back-filled in migratePickPhotos().
  `CREATE TABLE IF NOT EXISTS pick_photos (
    id SERIAL PRIMARY KEY,
    pick_id INTEGER NOT NULL REFERENCES picks(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    analysis_status TEXT NOT NULL DEFAULT 'pending',
    analysis_error TEXT,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    palette JSONB NOT NULL DEFAULT '[]'::jsonb,
    summary TEXT,
    analyzed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS pick_photos_pick_idx ON pick_photos (pick_id, position)`,
  `CREATE INDEX IF NOT EXISTS pick_photos_status_idx ON pick_photos (analysis_status)`,
  `CREATE TABLE IF NOT EXISTS reactions (
    id SERIAL PRIMARY KEY,
    pick_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    emoji TEXT,
    comment TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS reactions_pick_idx ON reactions (pick_id)`,
  // Shopping price lookups (server/prices.ts): 24h cache per normalised query + daily provider-call budget.
  `CREATE TABLE IF NOT EXISTS price_cache (
    query TEXT PRIMARY KEY,
    offers TEXT NOT NULL DEFAULT '[]',
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS price_budget (
    day TEXT PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0
  )`,
  // "Report a problem" / "Suggest an idea" (server/feedback.ts). kind is 'problem' | 'suggestion';
  // github_issue_url is filled when GITHUB_ISSUES_TOKEN is configured.
  `CREATE TABLE IF NOT EXISTS feedback (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'problem',
    message TEXT NOT NULL,
    page TEXT,
    user_agent TEXT,
    app_version TEXT,
    last_error TEXT,
    screenshot_path TEXT,
    github_issue_url TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE feedback ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'problem'`,
  `CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS feedback_user_idx ON feedback (user_id)`,
  // Discover (server/discover.ts): one public post per pick; likes, follows and reports hang off it.
  `CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY,
    pick_id INTEGER NOT NULL UNIQUE REFERENCES picks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    caption TEXT,
    vibe TEXT NOT NULL DEFAULT 'other',
    photo_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    like_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    status_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS posts_status_created_idx ON posts (status, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS posts_status_vibe_idx ON posts (status, vibe)`,
  `CREATE INDEX IF NOT EXISTS posts_top_idx ON posts (status, like_count DESC, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS posts_user_idx ON posts (user_id, status)`,
  `CREATE TABLE IF NOT EXISTS post_likes (
    id SERIAL PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS post_likes_post_user_uq ON post_likes (post_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS post_likes_user_idx ON post_likes (user_id)`,
  `CREATE TABLE IF NOT EXISTS follows (
    id SERIAL PRIMARY KEY,
    follower_id INTEGER NOT NULL,
    followee_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS follows_pair_uq ON follows (follower_id, followee_id)`,
  `CREATE INDEX IF NOT EXISTS follows_followee_idx ON follows (followee_id)`,
  `CREATE TABLE IF NOT EXISTS post_reports (
    id SERIAL PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER,
    reporter_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS post_reports_post_reporter_uq ON post_reports (post_id, reporter_key)`,
  `CREATE INDEX IF NOT EXISTS post_reports_created_idx ON post_reports (created_at DESC)`,
];

async function migrate(db: Db) {
  for (const stmt of DDL) await db.execute(sql.raw(stmt));
  await migratePickPhotos(db);
}

/**
 * Back-fill: every pick without a pick_photos row gets one from its own photo_path (position 0) carrying the
 * pick's status / items / palette / error / analyzed_at, so existing outfits keep their analysis. Done row by row
 * in JS so a malformed legacy JSON string cannot abort the boot (it is stored as [] instead).
 */
async function migratePickPhotos(db: Db) {
  const res = await db.execute(sql`
    SELECT p.id, p.photo_path, p.analysis_status, p.analysis_error, p.items, p.palette, p.analyzed_at, p.created_at
    FROM picks p
    WHERE NOT EXISTS (SELECT 1 FROM pick_photos ph WHERE ph.pick_id = p.id)
    ORDER BY p.id`);
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
  if (rows.length === 0) return;
  const parseJson = (v: unknown): unknown[] => {
    if (Array.isArray(v)) return v;
    try {
      const parsed = JSON.parse(String(v ?? "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  let n = 0;
  for (const r of rows) {
    const status = r.analysis_status === "pending" || r.analysis_status === "failed" ? String(r.analysis_status) : "ready";
    const analyzedAt = r.analyzed_at ? new Date(r.analyzed_at as string | Date) : status === "ready" ? new Date() : null;
    const createdAt = (() => {
      const d = new Date(String(r.created_at ?? ""));
      return Number.isNaN(d.getTime()) ? new Date() : d;
    })();
    try {
      await db.execute(sql`
        INSERT INTO pick_photos (pick_id, path, position, analysis_status, analysis_error, items, palette, summary, analyzed_at, created_at)
        VALUES (${r.id as number}, ${String(r.photo_path)}, 0, ${status}, ${(r.analysis_error as string | null) ?? null},
                ${JSON.stringify(parseJson(r.items))}::jsonb, ${JSON.stringify(parseJson(r.palette))}::jsonb, NULL,
                ${analyzedAt ? analyzedAt.toISOString() : null}::timestamptz, ${createdAt.toISOString()}::timestamptz)`);
      n++;
    } catch (err) {
      console.error(`[db] pick_photos back-fill failed for pick ${String(r.id)}`, err);
    }
  }
  console.log(`[db] pick_photos: back-filled ${n} legacy pick(s)`);
}
