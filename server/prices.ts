import { eq, sql } from "drizzle-orm";
import { priceCache, priceBudget } from "@shared/schema";
import type { Offer } from "@shared/schema";
import { getDb } from "./db";

export type { Offer } from "@shared/schema";

/**
 * Lazy shopping-price lookups for a garment search query.
 *
 * Provider A — SerpApi Google Shopping (https://serpapi.com/google-shopping-api)
 *   GET https://serpapi.com/search?engine=google_shopping&q=...&hl=en&gl=us&num=10&direct_link=true&api_key=SERPAPI_KEY
 *   → { shopping_results: [{ title, source, price: "$92.00", extracted_price: 92, link?, product_link,
 *        immersive_product_page_token, serpapi_immersive_product_api, thumbnail }] }
 *   `link`         direct merchant URL. Only present with `direct_link=true`, and SerpApi's release notes
 *                  carry a disclaimer that it can still be missing for some results
 *                  (https://serpapi.com/google-shopping-api/release-notes — "Support direct_link" Sep 2024,
 *                  "disclaimer ... link missing even when direct_link=true" Mar 2025). The current parameter
 *                  table on the docs page no longer lists it, so treat it as best-effort.
 *   `product_link` google.com product page — fallback only.
 *   `immersive_product_page_token` → Provider A2 below.
 *
 * Provider A2 — SerpApi Google Immersive Product (https://serpapi.com/google-immersive-product-api)
 *   GET https://serpapi.com/search?engine=google_immersive_product&page_token=...&api_key=SERPAPI_KEY
 *   → { product_results: { title, stores: [{ name, link, price: "$98.00", extracted_price: 98, ... }] } }
 *   `stores[].link` is the merchant URL. Used ONLY for offers that still lack a direct link, for the
 *   cheapest PRICE_DIRECT_RESOLVE_PER_ITEM offers per query (default 1); each call costs 1 unit of the
 *   daily budget. Resolved urls are written back into the same price_cache row.
 *
 * Provider B — HasData Google Shopping (https://docs.hasdata.com/apis/google-serp/shopping)
 *   GET https://api.hasdata.com/scrape/google/shopping?q=...&gl=us&hl=en   header x-api-key: HASDATA_API_KEY
 *   → { shoppingResults: [{ position, title, productId, price: "$419.00", extractedPrice: 419, source, thumbnail, delivery, ... }] }
 *   No merchant link in shoppingResults (https://hasdata.com/apis/google-shopping-api), so we link to the
 *   Google Shopping search for the product title (direct: false).
 *
 * Google ad redirects (google.com/aclk, googleadservices.com/pagead/aclk ... ?adurl=<merchant>) are
 * unwrapped to the `adurl` target so the offer counts as direct.
 *
 * Budget: PRICE_LOOKUPS_PER_DAY provider calls per UTC day (default 12 ≈ 360/month) counted in price_budget.
 *   One pick with 4 items costs up to 4 shopping searches + up to 4×PRICE_DIRECT_RESOLVE_PER_ITEM resolves.
 * Cache: price_cache (24h TTL) + in-process memo; stale rows are served when providers fail or budget is spent.
 *
 * Test hooks: MOCK_PRICES_JSON = SerpApi-shaped shopping body. `{ "error": "...", "status": 429 }` simulates a failure.
 *             MOCK_IMMERSIVE_JSON = immersive body `{ product_results: {...} }`, or a map `{ "<page_token>": body }`.
 */

const TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 20000; // SerpApi with direct_link=true regularly needs >8s; a timeout still burns one budget unit
const MAX_OFFERS = 6;

export type LookupSource = "memo" | "db" | "provider" | "stale" | "budget" | "none";
export interface LookupResult {
  offers: Offer[];
  from: LookupSource;
  provider?: Offer["source"];
  error?: string;
  /** Number of Immersive Product calls made (and charged to the budget) during this lookup. */
  resolved?: number;
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

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function dailyBudget(): number {
  return envInt("PRICE_LOOKUPS_PER_DAY", 12);
}

/** How many non-direct offers per query may be resolved through the Immersive Product API (cheapest first). */
export function directResolvePerItem(): number {
  return envInt("PRICE_DIRECT_RESOLVE_PER_ITEM", 1);
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

function isHttp(u: string): boolean {
  return /^https?:\/\//i.test(u);
}

function googleShoppingUrl(title: string): string {
  return `https://www.google.com/search?udm=28&q=${encodeURIComponent(title)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** google.com, www.google.co.uk, shopping.google.com, googleadservices.com, googlesyndication.com ... */
export function isGoogleHost(host: string): boolean {
  return /(^|\.)google\.[a-z.]+$/.test(host) || /(^|\.)google(adservices|syndication|usercontent)\.com$/.test(host);
}

/** Hostname without a leading "www." — what the client shows next to a direct offer. "" for google/invalid. */
export function retailerHostOf(url: string): string {
  const host = hostOf(url);
  if (!host || isGoogleHost(host)) return "";
  return host.replace(/^www\./, "");
}

/**
 * Unwrap Google ad-click redirects: https://www.google.com/aclk?...&adurl=https%3A%2F%2Fshop.example.com%2Fp
 * and https://www.googleadservices.com/pagead/aclk?...&adurl=... (also /url?q=... and ?url=...).
 * Anything else is returned unchanged.
 */
export function normalizeOfferUrl(url: string): string {
  if (!isHttp(url)) return url;
  const host = hostOf(url);
  if (!host || !isGoogleHost(host)) return url;
  try {
    const u = new URL(url);
    const isRedirect = /\/aclk$/.test(u.pathname) || /\/pagead\/aclk$/.test(u.pathname) || u.pathname === "/url";
    if (!isRedirect) return url;
    const target = u.searchParams.get("adurl") || u.searchParams.get("url") || u.searchParams.get("q") || "";
    if (isHttp(target) && !isGoogleHost(hostOf(target))) return target;
  } catch {
    /* fall through */
  }
  return url;
}

/** Fill `direct` + `retailerHost` from the (unwrapped) url. Idempotent. */
export function decorateOffer<T extends Pick<Offer, "url">>(o: T): T & Pick<Offer, "direct" | "retailerHost"> {
  const url = normalizeOfferUrl(o.url);
  const host = hostOf(url);
  const direct = Boolean(host) && !isGoogleHost(host);
  return { ...o, url, direct, retailerHost: direct ? retailerHostOf(url) : "" };
}

/** Sort ascending by price (unpriced last; direct first among equal prices), dedupe on seller+title, cap. */
export function finalizeOffers(raw: Offer[]): Offer[] {
  const seen = new Set<string>();
  const out: Offer[] = [];
  const sorted = [...raw].sort((a, b) => {
    const pa = a.price ?? Infinity;
    const pb = b.price ?? Infinity;
    if (pa !== pb) return pa - pb;
    return Number(b.direct) - Number(a.direct);
  });
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

function immersiveTokenOf(r: Record<string, unknown>): string | undefined {
  const tok = str(r.immersive_product_page_token);
  if (tok) return tok;
  const api = str(r.serpapi_immersive_product_api);
  if (api) {
    try {
      return new URL(api).searchParams.get("page_token") || undefined;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export function parseSerpApi(body: SerpApiBody): Offer[] {
  const rows = [...(body.shopping_results ?? []), ...(body.inline_shopping_results ?? [])];
  const offers: Offer[] = [];
  for (const r of rows) {
    const title = str(r.title);
    if (!title) continue;
    const link = normalizeOfferUrl(str(r.link));
    const productLink = str(r.product_link);
    const url = (isHttp(link) && link) || (isHttp(productLink) && productLink) || googleShoppingUrl(title);
    const price = toNumber(r.extracted_price) ?? toNumber(r.price);
    const immersiveToken = immersiveTokenOf(r);
    offers.push(
      decorateOffer({
        title,
        seller: str(r.source) || "Shop",
        price,
        priceText: str(r.price) || (price != null ? `$${price.toFixed(2)}` : ""),
        url,
        thumbnail: str(r.thumbnail) || undefined,
        source: "serpapi" as const,
        ...(immersiveToken ? { immersiveToken } : {}),
      }),
    );
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
    const link = normalizeOfferUrl(str(r.link) || str(r.productLink));
    const price = toNumber(r.extractedPrice) ?? toNumber(r.price);
    offers.push(
      decorateOffer({
        title,
        seller: str(r.source) || "Shop",
        price,
        priceText: str(r.price) || (price != null ? `$${price.toFixed(2)}` : ""),
        url: isHttp(link) ? link : googleShoppingUrl(title),
        thumbnail: str(r.thumbnail) || undefined,
        source: "hasdata" as const,
      }),
    );
  }
  return offers;
}

type ImmersiveBody = {
  error?: string;
  product_results?: { title?: string; stores?: Record<string, unknown>[] };
};

export interface ImmersiveStore {
  name: string;
  link: string;
  price: number | null;
  priceText: string;
}

export function parseImmersiveStores(body: ImmersiveBody): ImmersiveStore[] {
  const rows = body.product_results?.stores ?? [];
  const out: ImmersiveStore[] = [];
  for (const s of rows) {
    const link = normalizeOfferUrl(str(s.link));
    if (!isHttp(link) || isGoogleHost(hostOf(link))) continue;
    const price = toNumber(s.extracted_price) ?? toNumber(s.price);
    out.push({ name: str(s.name), link, price, priceText: str(s.price) });
  }
  return out;
}

function sellerKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s*[-–|·].*$/, "") // "Walmart - Seller" → "walmart"
    .replace(/\.(com|net|org|co\.uk|ca)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Store whose name matches the offer's seller, else the cheapest store (unpriced last). */
export function pickStore(stores: ImmersiveStore[], seller: string): ImmersiveStore | null {
  if (!stores.length) return null;
  const want = sellerKey(seller);
  if (want) {
    const match = stores.find((s) => {
      const have = sellerKey(s.name);
      return have && (have === want || have.startsWith(want) || want.startsWith(have));
    });
    if (match) return match;
  }
  return [...stores].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0] ?? null;
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
  u.searchParams.set("direct_link", "true"); // ask for merchant `link` on each result (best-effort, see header)
  u.searchParams.set("api_key", key);
  const body = (await fetchJson(u.toString(), { headers: { Accept: "application/json" } }, "serpapi")) as SerpApiBody;
  if (body.error && !body.shopping_results) throw new ProviderError("serpapi", 400, body.error);
  return parseSerpApi(body);
}

async function viaSerpApiImmersive(pageToken: string, key: string): Promise<ImmersiveStore[]> {
  const u = new URL("https://serpapi.com/search");
  u.searchParams.set("engine", "google_immersive_product");
  u.searchParams.set("page_token", pageToken);
  u.searchParams.set("api_key", key);
  const body = (await fetchJson(u.toString(), { headers: { Accept: "application/json" } }, "serpapi")) as ImmersiveBody;
  if (body.error && !body.product_results) throw new ProviderError("serpapi", 400, body.error);
  return parseImmersiveStores(body);
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

function viaMockImmersive(pageToken: string): ImmersiveStore[] {
  const raw = JSON.parse(process.env.MOCK_IMMERSIVE_JSON || "{}") as Record<string, unknown>;
  const body = ("product_results" in raw || "error" in raw ? raw : (raw[pageToken] as Record<string, unknown>) ?? {}) as ImmersiveBody & {
    status?: number;
  };
  if (body.error) throw new ProviderError("mock", Number(body.status) || 429, body.error);
  return parseImmersiveStores(body);
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

// ---------------------------------------------------------------- direct-link resolution

/**
 * For offers that still point at google.* and carry an immersive token, call the Immersive Product API
 * (cheapest first, at most `limit` offers) and swap in the merchant url. Each call is charged to the
 * daily budget; when the budget runs out we stop silently and keep the google url.
 * Returns the (re-sorted) offers and how many provider calls were made.
 */
export async function resolveDirectLinks(
  offers: Offer[],
  opts: { limit?: number; mock?: boolean; serpKey?: string } = {},
): Promise<{ offers: Offer[]; calls: number }> {
  const limit = opts.limit ?? directResolvePerItem();
  const mock = opts.mock ?? Boolean(process.env.MOCK_PRICES_JSON);
  const serpKey = opts.serpKey ?? process.env.SERPAPI_KEY?.trim();
  if (limit <= 0) return { offers, calls: 0 };
  if (mock ? !process.env.MOCK_IMMERSIVE_JSON : !serpKey) return { offers, calls: 0 };

  const candidates = offers
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => !o.direct && o.immersiveToken)
    .sort((a, b) => (a.o.price ?? Infinity) - (b.o.price ?? Infinity))
    .slice(0, limit);
  if (!candidates.length) return { offers, calls: 0 };

  const out = [...offers];
  let calls = 0;
  for (const { o, i } of candidates) {
    let ok = false;
    try {
      ok = await reserveBudget();
    } catch (err) {
      console.error("[prices] budget check failed", err);
    }
    if (!ok) {
      console.warn(`[prices] daily budget (${dailyBudget()}) spent; skipping direct-link resolve for "${o.title}"`);
      break;
    }
    calls++;
    try {
      const stores = mock ? viaMockImmersive(o.immersiveToken!) : await viaSerpApiImmersive(o.immersiveToken!, serpKey!);
      const store = pickStore(stores, o.seller);
      if (store) {
        out[i] = decorateOffer({ ...o, url: store.link, seller: o.seller || store.name });
      } else {
        console.warn(`[prices] immersive: no merchant link for "${o.title}" (${o.seller})`);
      }
    } catch (err) {
      console.warn(`[prices] immersive resolve failed for "${o.title}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { offers: finalizeOffers(out), calls };
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
    // decorateOffer() backfills direct/retailerHost on rows cached before those fields existed.
    offers = (JSON.parse(row.offers) as Offer[]).map((o) => decorateOffer(o));
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
  const attempts: { name: Offer["source"]; run: () => Promise<Offer[]>; resolve: boolean }[] = [];
  if (mock) attempts.push({ name: "serpapi", run: async () => viaMock(), resolve: true });
  else {
    if (serpKey) attempts.push({ name: "serpapi", run: () => viaSerpApi(key, serpKey), resolve: true });
    if (hasKey) attempts.push({ name: "hasdata", run: () => viaHasData(key, hasKey), resolve: false });
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
      let offers = finalizeOffers(await attempt.run());
      let resolved = 0;
      if (attempt.resolve) {
        // Immersive fallback for the cheapest google-linked offers. Budget-guarded; never throws.
        const r = await resolveDirectLinks(offers, { mock: Boolean(mock), serpKey });
        offers = r.offers;
        resolved = r.calls;
      }
      memo.set(key, { offers, fetchedAt: Date.now() });
      try {
        await writeDbCache(key, offers); // resolved urls land in the same row → later reads cost nothing
      } catch (err) {
        console.error("[prices] cache write failed", err);
      }
      return { offers, from: "provider", provider: attempt.name, resolved };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const quota = err instanceof ProviderError && err.quota;
      console.warn(`[prices] ${attempt.name} failed${quota ? " (quota)" : ""}: ${lastError}`);
      // Any failure (429/quota, 5xx, timeout, bad key) falls through to the next provider.
    }
  }
  return stale(lastError || "no provider available");
}
