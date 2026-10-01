/**
 * Node-side harness driven by tests/test_prices_mock.py:
 *   PGLITE_DIR=/tmp/x MOCK_PRICES_JSON='{...}' npx tsx tests/prices_harness.ts
 * Runs the price-lookup scenarios in ONE process (so memo/in-flight behaviour is exercised)
 * and prints a single JSON document for the Python test to assert on.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  lookupOffersWithMeta,
  parseSerpApi,
  parseHasData,
  finalizeOffers,
  clearMemo,
  budgetUsedToday,
  normalizeQuery,
} from "../server/prices";
import { wrapLink, presentOffers, isAmazonUrl } from "../server/affiliate";
import type { Offer } from "../shared/schema";

const out: Record<string, unknown> = {};

async function main() {
  await getDb();

  // ---- pure parsing / sorting / dedupe / cap
  const mockBody = JSON.parse(process.env.MOCK_PRICES_JSON || "{}");
  const parsed = parseSerpApi(mockBody);
  const finalized = finalizeOffers(parsed);
  out.parse = {
    rawCount: parsed.length,
    finalCount: finalized.length,
    prices: finalized.map((o) => o.price),
    sellers: finalized.map((o) => o.seller),
    titles: finalized.map((o) => o.title),
    urls: finalized.map((o) => o.url),
    sources: Array.from(new Set(finalized.map((o) => o.source))),
    thumbnails: finalized.map((o) => o.thumbnail ?? null),
  };
  out.hasdata = parseHasData({
    shoppingResults: [
      { position: 1, title: "Apple MacBook Air M1 Chip", productId: "143", price: "$419.00", extractedPrice: 419, source: "Walmart - Seller", thumbnail: "https://files.hasdata.com/x.webp" },
      { position: 2, title: "No price item", source: "Target" },
    ],
  });

  // ---- lookup #1: provider call, budget 1
  const q = "  Lululemon   Align Legging BLACK ";
  const r1 = await lookupOffersWithMeta(q);
  out.lookup1 = { from: r1.from, provider: r1.provider, count: r1.offers.length, budget: await budgetUsedToday(), key: normalizeQuery(q) };

  // ---- lookup #2: same query (different whitespace/case) → memo, budget unchanged
  const r2 = await lookupOffersWithMeta("lululemon align legging black");
  out.lookup2 = { from: r2.from, count: r2.offers.length, budget: await budgetUsedToday() };

  // ---- lookup #3: new process simulated via clearMemo → db cache, budget unchanged
  clearMemo();
  const r3 = await lookupOffersWithMeta(q);
  out.lookup3 = { from: r3.from, count: r3.offers.length, budget: await budgetUsedToday() };

  // ---- concurrent identical lookups share one in-flight provider call
  clearMemo();
  const [c1, c2] = await Promise.all([lookupOffersWithMeta("Nike Pegasus 41"), lookupOffersWithMeta("nike pegasus 41")]);
  out.concurrent = { from: [c1.from, c2.from], budget: await budgetUsedToday() };

  // ---- budget guard: limit 2 already used → new query gets nothing, no provider call
  process.env.PRICE_LOOKUPS_PER_DAY = "2";
  const r4 = await lookupOffersWithMeta("Hoka Clifton 9 white");
  out.budget = { from: r4.from, count: r4.offers.length, budget: await budgetUsedToday() };
  // cached query still served from cache under a spent budget
  const r5 = await lookupOffersWithMeta(q);
  out.budgetCached = { from: r5.from, count: r5.offers.length };

  // ---- stale cache: expire the row, spend budget → stale served; then provider 429 → stale served
  const db = await getDb();
  await db.execute(sql`UPDATE price_cache SET fetched_at = now() - interval '2 days' WHERE query = ${normalizeQuery(q)}`);
  clearMemo();
  const r6 = await lookupOffersWithMeta(q);
  out.staleBudget = { from: r6.from, count: r6.offers.length, error: r6.error ?? null };
  process.env.PRICE_LOOKUPS_PER_DAY = "50";
  process.env.MOCK_PRICES_JSON = JSON.stringify({ error: "Your account has run out of searches.", status: 429 });
  clearMemo();
  const r7 = await lookupOffersWithMeta(q);
  out.staleQuota = { from: r7.from, count: r7.offers.length, error: r7.error ?? null, budget: await budgetUsedToday() };
  // brand-new query with a failing provider and no cache → empty
  const r8 = await lookupOffersWithMeta("Vuori Performance Jogger");
  out.failNoCache = { from: r8.from, count: r8.offers.length };

  // ---- no providers configured → [] quickly, no budget use
  delete process.env.MOCK_PRICES_JSON;
  delete process.env.SERPAPI_KEY;
  delete process.env.HASDATA_API_KEY;
  const before = await budgetUsedToday();
  const t0 = Date.now();
  const r9 = await lookupOffersWithMeta("Alo Yoga Airlift bra");
  out.noProvider = { from: r9.from, count: r9.offers.length, ms: Date.now() - t0, budgetDelta: (await budgetUsedToday()) - before };

  // ---- wrapLink
  const cfgNone = {};
  const cfgAll = { amazonTag: "mmv-20", sovrnKey: "sovrn123" };
  const amazonUrl = "https://www.amazon.com/dp/B0ABC?tag=old-20&ref=x";
  const retailer = "https://shop.lululemon.com/p/leggings/Align-Pant?color=black";
  const google = "https://www.google.com/search?tbm=shop&q=leggings";
  out.wrap = {
    unchangedNoKeys: [wrapLink(amazonUrl, cfgNone), wrapLink(retailer, cfgNone)],
    amazon: wrapLink(amazonUrl, cfgAll),
    amazonUk: wrapLink("https://www.amazon.co.uk/s?k=leggings", { amazonTag: "mmv-21" }),
    amazonOnlySovrn: wrapLink(amazonUrl, { sovrnKey: "sovrn123" }),
    retailer: wrapLink(retailer, cfgAll),
    google: wrapLink(google, cfgAll),
    relative: wrapLink("/not-a-url", cfgAll),
    doubleWrap: wrapLink(wrapLink(retailer, cfgAll), cfgAll),
    isAmazon: [isAmazonUrl(amazonUrl), isAmazonUrl(retailer), isAmazonUrl("https://amzn.to/abc")],
  };

  // ---- presentOffers (Amazon masking + wrapping)
  const offers: Offer[] = [
    { title: "A", seller: "Amazon.com", price: 10, priceText: "$10.00", url: "https://www.amazon.com/dp/B01", source: "serpapi" },
    { title: "B", seller: "Amazon.com - Seller", price: 11, priceText: "$11.00", url: "https://www.google.com/shopping/product/1", source: "serpapi" },
    { title: "C", seller: "Walmart", price: 12, priceText: "$12.00", url: "https://www.walmart.com/ip/1", source: "serpapi" },
  ];
  out.present = presentOffers(offers, cfgAll).map((o) => ({ price: o.price, priceText: o.priceText, url: o.url }));

  console.log(JSON.stringify(out));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
