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
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS picks_session_idx ON picks (session_id)`,
  `CREATE INDEX IF NOT EXISTS picks_user_idx ON picks (user_id)`,
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
];

async function migrate(db: Db) {
  for (const stmt of DDL) await db.execute(sql.raw(stmt));
}
