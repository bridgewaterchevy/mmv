import { eq, sql } from "drizzle-orm";
import { priceCache, priceBudget } from "@shared/schema";
import type { Offer } from "@shared/schema";
import { getDb } from "./db";

export type { Offer } from "@shared/schema";

/**
 * Lazy shopping-price lookups for a garment search query.
 *
 * Provider A — SerpApi Google Shopping (https://serpapi.com/google-shopping-api)
 *   GET https://serpapi.com/search?engine=google_shopping&q=...&hl=en&gl=us&num=10&api_key=SERPAPI_KEY
 *   → { shopping_results: [{ title, source, price: "$92.00", extracted_price: 92, product_link, link?, thumbnail }] }
 *   `product_link` is a google.com product page; some layouts also carry a direct merchant `link`.
 *   429 = hourly throughput exceeded OR account out of searches (https://serpapi.com/api-status-and-error-codes).
 *   Free plan: 250 searches / month (https://serpapi.com/pricing).
 *
 * Provider B — HasData Google Shopping (https://docs.hasdata.com/apis/google-serp/shopping)
 *   GET https://api.hasdata.com/scrape/google/shopping?q=...&gl=us&hl=en   header x-api-key: HASDATA_API_KEY
 *   → { shoppingResults: [{ position, title, productId, price: "$419.00", extractedPrice: 419, source, thumbnail, delivery, ... }] }
 *   No merchant link in shoppingResults (https://hasdata.com/apis/google-shopping-api), so we link to the
 *   Google Shopping search for the product title.
 *
 * Budget: PRICE_LOOKUPS_PER_DAY provider calls per UTC day (default 8 ≈ 240/month) counted in price_budget.
 * Cache: price_cache (24h TTL) + in-process memo; stale rows are served when providers fail or budget is spent.
 *
 * Test hook: MOCK_PRICES_JSON = SerpApi-shaped JSON body. `{ "error": "...", "status": 429 }` simulates a failure.
 */

const TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 8000;
const MAX_OFFERS = 6;

export type LookupSource = "memo" | "db" | "provider" | "stale" | "budget" | "none";
export interface LookupResult {
  offers: Offer[];
  from: LookupSource;
  provider?: Offer["source"];
  error?: string;
}

export class ProviderError extends Error {
  constructor(
    public provider: Offer["source"] | "mock",
    public status: number,
    message: string,
  ) {
    super(message);
  }
  get quota() {
    return this.status === 429 || this.status === 402;
  }
}

// ---------------------------------------------------------------- helpers

export function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, " ");
}

export function dailyBudget(): number {
  const n = Number(process.env.PRICE_LOOKUPS_PER_DAY ?? 8);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 8;
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.replace(/,/g, "").match(/\d+(\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function googleShoppingUrl(title: string): string {
  return `https://www.google.com/search?udm=28&q=${encodeURIComponent(title)}`;
}

/** Sort ascending by price (unpriced last), dedupe on seller+title, cap. */
export function finalizeOffers(raw: Offer[]): Offer[] {
  const seen = new Set<string>();
  const out: Offer[] = [];
  const sorted = [...raw].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  for (const o of sorted) {
    if (!o.title || !o.url) continue;
    const key = `${o.seller.toLowerCase()}|${o.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
    if (out.length >= MAX_OFFERS) break;
  }
  return out;
}

// ---------------------------------------------------------------- parsers (exported for tests)

type SerpApiBody = {
  error?: string;
  shopping_results?: Record<string, unknown>[];
  inline_shopping_results?: Record<string, unknown>[];
};

export function parseSerpApi(body: SerpApiBody): Offer[] {
  const rows = [...(body.shopping_results ?? []), ...(body.inline_shopping_results ?? [])];
  const offers: Offer[] = [];
  for (const r of rows) {
    const title = str(r.title);
    if (!title) continue;
    const link = str(r.link);
    const productLink = str(r.product_link);
    const url = (/^https?:\/\//.test(link) && link) || (/^https?:\/\//.test(productLink) && productLink) || googleShoppingUrl(title);
    const price = toNumber(r.extracted_price) ?? toNumber(r.price);
    offers.push({
      title,
      seller: str(r.source) || "Shop",
      price,
      priceText: str(r.price) || (price != null ? `$${price.toFixed(2)}` : ""),
      url,
      thumbnail: str(r.thumbnail) || undefined,
      source: "serpapi",
    });
  }
  return offers;
}

type HasDataBody = { shoppingResults?: Record<string, unknown>[]; inlineShoppingResults?: Record<string, unknown>[] };

export function parseHasData(body: HasDataBody): Offer[] {
  const rows = [...(body.shoppingResults ?? []), ...(body.inlineShoppingResults ?? [])];
  const offers: Offer[] = [];
  for (const r of rows) {
    const title = str(r.title);
    if (!title) continue;
    const link = str(r.link) || str(r.productLink);
    const price = toNumber(r.extractedPrice) ?? toNumber(r.price);
    offers.push({
      title,
      seller: str(r.source) || "Shop",
      price,
      priceText: str(r.price) || (price != null ? `$${price.toFixed(2)}` : ""),
      url: /^https?:\/\//.test(link) ? link : googleShoppingUrl(title),
      thumbnail: str(r.thumbnail) || undefined,
      source: "hasdata",
    });
  }
  return offers;
}

// ---------------------------------------------------------------- providers

async function fetchJson(url: string, init: RequestInit, provider: Offer["source"]): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new ProviderError(provider, res.status, `${provider} ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(provider, 502, `${provider}: non-JSON response`);
  }
}

async function viaSerpApi(query: string, key: string): Promise<Offer[]> {
  const u = new URL("https://serpapi.com/search");
  u.searchParams.set("engine", "google_shopping");
  u.searchParams.set("q", query);
  u.searchParams.set("hl", "en");
  u.searchParams.set("gl", "us");
  u.searchParams.set("num", "10");
  u.searchParams.set("api_key", key);
  const body = (await fetchJson(u.toString(), { headers: { Accept: "application/json" } }, "serpapi")) as SerpApiBody;
  if (body.error && !body.shopping_results) throw new ProviderError("serpapi", 400, body.error);
  return parseSerpApi(body);
}

async function viaHasData(query: string, key: string): Promise<Offer[]> {
  const u = new URL("https://api.hasdata.com/scrape/google/shopping");
  u.searchParams.set("q", query);
  u.searchParams.set("gl", "us");
  u.searchParams.set("hl", "en");
  const body = (await fetchJson(u.toString(), { headers: { "x-api-key": key, Accept: "application/json" } }, "hasdata")) as HasDataBody;
  return parseHasData(body);
}

function viaMock(): Offer[] {
  const body = JSON.parse(process.env.MOCK_PRICES_JSON || "{}") as SerpApiBody & { status?: number };
  if (body.error) throw new ProviderError("mock", Number(body.status) || 429, body.error);
  return parseSerpApi(body);
}

// ---------------------------------------------------------------- budget

/** Reserve one provider call for today. Returns false (without incrementing) when the budget is spent. */
export async function reserveBudget(limit = dailyBudget()): Promise<boolean> {
  if (limit <= 0) return false;
  const db = await getDb();
  const day = utcDay();
  await db.insert(priceBudget).values({ day, calls: 0 }).onConflictDoNothing();
  const rows = await db
    .update(priceBudget)
    .set({ calls: sql`${priceBudget.calls} + 1` })
    .where(sql`${priceBudget.day} = ${day} AND ${priceBudget.calls} < ${limit}`)
    .returning({ calls: priceBudget.calls });
  return rows.length > 0;
}

export async function budgetUsedToday(): Promise<number> {
  const db = await getDb();
  const [row] = await db.select().from(priceBudget).where(eq(priceBudget.day, utcDay())).limit(1);
  return row?.calls ?? 0;
}

// ---------------------------------------------------------------- cache

const memo = new Map<string, { offers: Offer[]; fetchedAt: number }>();
const inflight = new Map<string, Promise<LookupResult>>();

async function readDbCache(key: string): Promise<{ offers: Offer[]; fetchedAt: number } | null> {
  const db = await getDb();
  const [row] = await db.select().from(priceCache).where(eq(priceCache.query, key)).limit(1);
  if (!row) return null;
  let offers: Offer[] = [];
  try {
    offers = JSON.parse(row.offers) as Offer[];
  } catch {
    offers = [];
  }
  const fetchedAt = row.fetchedAt instanceof Date ? row.fetchedAt.getTime() : new Date(row.fetchedAt as unknown as string).getTime();
  return { offers, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : 0 };
}

async function writeDbCache(key: string, offers: Offer[]): Promise<void> {
  const db = await getDb();
  const fetchedAt = new Date();
  await db
    .insert(priceCache)
    .values({ query: key, offers: JSON.stringify(offers), fetchedAt })
    .onConflictDoUpdate({ target: priceCache.query, set: { offers: JSON.stringify(offers), fetchedAt } });
}

/** Test/ops helper: forget everything this process remembers. */
export function clearMemo(): void {
  memo.clear();
  inflight.clear();
}

// ---------------------------------------------------------------- public API

export function providersConfigured(): boolean {
  return Boolean(process.env.SERPAPI_KEY || process.env.HASDATA_API_KEY || process.env.MOCK_PRICES_JSON);
}

/** Offers (unwrapped urls, Amazon prices still present). Route layer applies presentOffers(). */
export async function lookupOffers(query: string): Promise<Offer[]> {
  return (await lookupOffersWithMeta(query)).offers;
}

export async function lookupOffersWithMeta(query: string): Promise<LookupResult> {
  const key = normalizeQuery(query);
  if (!key) return { offers: [], from: "none" };

  const m = memo.get(key);
  if (m && Date.now() - m.fetchedAt < TTL_MS) return { offers: m.offers, from: "memo" };

  const running = inflight.get(key);
  if (running) return running;
  const p = doLookup(key).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function doLookup(key: string): Promise<LookupResult> {
  const now = Date.now();
  let cached: { offers: Offer[]; fetchedAt: number } | null = null;
  try {
    cached = await readDbCache(key);
  } catch (err) {
    console.error("[prices] cache read failed", err);
  }
  if (cached && now - cached.fetchedAt < TTL_MS) {
    memo.set(key, cached);
    return { offers: cached.offers, from: "db" };
  }

  if (!providersConfigured()) return { offers: cached?.offers ?? [], from: cached ? "stale" : "none" };

  const stale = (error: string): LookupResult => ({ offers: cached?.offers ?? [], from: cached ? "stale" : "none", error });

  const mock = process.env.MOCK_PRICES_JSON;
  const serpKey = process.env.SERPAPI_KEY?.trim();
  const hasKey = process.env.HASDATA_API_KEY?.trim();

  // Each provider attempt costs one unit of the daily budget.
  const attempts: { name: Offer["source"]; run: () => Promise<Offer[]> }[] = [];
  if (mock) attempts.push({ name: "serpapi", run: async () => viaMock() });
  else {
    if (serpKey) attempts.push({ name: "serpapi", run: () => viaSerpApi(key, serpKey) });
    if (hasKey) attempts.push({ name: "hasdata", run: () => viaHasData(key, hasKey) });
  }

  let lastError = "";
  for (const attempt of attempts) {
    let ok = false;
    try {
      ok = await reserveBudget();
    } catch (err) {
      console.error("[prices] budget check failed", err);
      ok = false;
    }
    if (!ok) {
      console.warn(`[prices] daily budget (${dailyBudget()}) spent; serving ${cached ? "stale cache" : "nothing"} for "${key}"`);
      return { ...stale("budget"), from: cached ? "stale" : "budget" };
    }
    try {
      const offers = finalizeOffers(await attempt.run());
      memo.set(key, { offers, fetchedAt: Date.now() });
      try {
        await writeDbCache(key, offers);
      } catch (err) {
        console.error("[prices] cache write failed", err);
      }
      return { offers, from: "provider", provider: attempt.name };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const quota = err instanceof ProviderError && err.quota;
      console.warn(`[prices] ${attempt.name} failed${quota ? " (quota)" : ""}: ${lastError}`);
      // Any failure (429/quota, 5xx, timeout, bad key) falls through to the next provider.
    }
  }
  return stale(lastError || "no provider available");
}
