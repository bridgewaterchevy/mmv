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
  normalizeOfferUrl,
  parseImmersiveStores,
  pickStore,
  resolveDirectLinks,
  dailyBudget,
  directResolvePerItem,
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
    direct: finalized.map((o) => o.direct),
    hosts: finalized.map((o) => o.retailerHost),
    tokens: finalized.map((o) => o.immersiveToken ?? null),
  };
  {
    const savedB = process.env.PRICE_LOOKUPS_PER_DAY;
    const savedR = process.env.PRICE_DIRECT_RESOLVE_PER_ITEM;
    delete process.env.PRICE_LOOKUPS_PER_DAY;
    delete process.env.PRICE_DIRECT_RESOLVE_PER_ITEM;
    out.defaults = { budget: dailyBudget(), resolvePerItem: directResolvePerItem() };
    if (savedB !== undefined) process.env.PRICE_LOOKUPS_PER_DAY = savedB;
    if (savedR !== undefined) process.env.PRICE_DIRECT_RESOLVE_PER_ITEM = savedR;
  }
  out.adurl = {
    aclk: normalizeOfferUrl("https://www.google.com/aclk?sa=L&ai=DChc&adurl=https%3A%2F%2Fshop.lululemon.com%2Fp%2Falign%3Fcolor%3Dblack%26sz%3D6"),
    adservices: normalizeOfferUrl("https://www.googleadservices.com/pagead/aclk?sa=L&ai=x&adurl=https://www.nordstrom.com/s/123"),
    plain: normalizeOfferUrl("https://www.walmart.com/ip/1?x=1"),
    productPage: normalizeOfferUrl("https://www.google.com/shopping/product/1"),
    noAdurl: normalizeOfferUrl("https://www.google.com/aclk?sa=L&ai=x"),
  };
  // HasData: never a merchant link → direct:false, retailerHost ""
  out.hasdataDirect = parseHasData({ shoppingResults: [{ title: "A", source: "Target", extractedPrice: 10 }] }).map((o) => [o.direct, o.retailerHost, o.url.includes("google.com")]);
  out.hasdata = parseHasData({
    shoppingResults: [
      { position: 1, title: "Apple MacBook Air M1 Chip", productId: "143", price: "$419.00", extractedPrice: 419, source: "Walmart - Seller", thumbnail: "https://files.hasdata.com/x.webp" },
      { position: 2, title: "No price item", source: "Target" },
    ],
  });

  // ---- lookup #1: provider call, budget 1
  const q = "  Lululemon   Align Legging BLACK ";
  const r1 = await lookupOffersWithMeta(q);
  out.lookup1 = {
    from: r1.from, provider: r1.provider, count: r1.offers.length, budget: await budgetUsedToday(), key: normalizeQuery(q),
    resolved: r1.resolved ?? 0,
    offers: r1.offers.map((o) => ({ seller: o.seller, price: o.price, url: o.url, direct: o.direct, retailerHost: o.retailerHost, token: o.immersiveToken ?? null })),
  };

  // ---- lookup #2: same query (different whitespace/case) → memo, budget unchanged
  const r2 = await lookupOffersWithMeta("lululemon align legging black");
  out.lookup2 = { from: r2.from, count: r2.offers.length, budget: await budgetUsedToday() };

  // ---- lookup #3: new process simulated via clearMemo → db cache, budget unchanged
  clearMemo();
  const r3 = await lookupOffersWithMeta(q);
  out.lookup3 = { from: r3.from, count: r3.offers.length, budget: await budgetUsedToday(), urls: r3.offers.map((o) => o.url), direct: r3.offers.map((o) => o.direct) };

  // ---- concurrent identical lookups share one in-flight provider call
  clearMemo();
  const [c1, c2] = await Promise.all([lookupOffersWithMeta("Nike Pegasus 41"), lookupOffersWithMeta("nike pegasus 41")]);
  out.concurrent = { from: [c1.from, c2.from], budget: await budgetUsedToday() };

  // ---- budget guard: limit 2 already used → new query gets nothing, no provider call
  process.env.PRICE_LOOKUPS_PER_DAY = "3";
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

  // ---- immersive parsing + store choice (pure)
  const immersiveBody = JSON.parse(process.env.MOCK_IMMERSIVE_JSON || "{}");
  const stores = parseImmersiveStores(immersiveBody["tok-lulu"]);
  out.immersive = {
    storeCount: stores.length,
    links: stores.map((s) => s.link),
    bySeller: pickStore(stores, "lululemon")?.link ?? null,
    bySellerSuffix: pickStore(stores, "Nordstrom - Seller")?.link ?? null,
    cheapestWhenUnknown: pickStore(stores, "Nobody Inc")?.link ?? null,
    emptyBody: parseImmersiveStores({}).length,
  };

  // ---- resolve: budget spent during resolve → google url kept, no throw
  process.env.PRICE_LOOKUPS_PER_DAY = "0";
  const unresolved: Offer[] = [
    { title: "T", seller: "lululemon", price: 98, priceText: "$98.00", url: "https://www.google.com/shopping/product/1", direct: false, retailerHost: "", source: "serpapi", immersiveToken: "tok-lulu" },
  ];
  const rb = await resolveDirectLinks(unresolved, { mock: true });
  out.resolveNoBudget = { calls: rb.calls, direct: rb.offers[0].direct, url: rb.offers[0].url };
  // ---- resolve: limit 2 → two calls, cheapest two resolved, third untouched
  process.env.PRICE_LOOKUPS_PER_DAY = "50";
  const beforeR = await budgetUsedToday();
  const three: Offer[] = [
    { title: "C", seller: "lululemon", price: 120, priceText: "$120.00", url: "https://www.google.com/shopping/product/3", direct: false, retailerHost: "", source: "serpapi", immersiveToken: "tok-lulu" },
    { title: "A", seller: "lululemon", price: 98, priceText: "$98.00", url: "https://www.google.com/shopping/product/1", direct: false, retailerHost: "", source: "serpapi", immersiveToken: "tok-lulu" },
    { title: "B", seller: "Target", price: 45, priceText: "$45.00", url: "https://www.google.com/shopping/product/2", direct: false, retailerHost: "", source: "serpapi", immersiveToken: "tok-target" },
    { title: "D", seller: "Walmart", price: 10, priceText: "$10.00", url: "https://www.walmart.com/ip/1", direct: true, retailerHost: "walmart.com", source: "serpapi", immersiveToken: "tok-lulu" },
  ];
  const r2x = await resolveDirectLinks(three, { mock: true, limit: 2 });
  out.resolveLimit2 = { calls: r2x.calls, budgetDelta: (await budgetUsedToday()) - beforeR, offers: r2x.offers.map((o) => ({ title: o.title, direct: o.direct, host: o.retailerHost })) };
  // ---- resolve: immersive 429 → google url kept, still charged once
  const savedImm = process.env.MOCK_IMMERSIVE_JSON;
  process.env.MOCK_IMMERSIVE_JSON = JSON.stringify({ error: "Your account has run out of searches.", status: 429 });
  const rq = await resolveDirectLinks(unresolved, { mock: true });
  out.resolveQuota = { calls: rq.calls, direct: rq.offers[0].direct };
  process.env.MOCK_IMMERSIVE_JSON = savedImm;
  // ---- equal prices: direct preferred
  out.tieSort = finalizeOffers([
    { title: "g", seller: "G", price: 50, priceText: "$50", url: "https://www.google.com/shopping/product/9", direct: false, retailerHost: "", source: "serpapi" },
    { title: "d", seller: "D", price: 50, priceText: "$50", url: "https://www.rei.com/p/9", direct: true, retailerHost: "rei.com", source: "serpapi" },
  ]).map((o) => o.title);

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
    { title: "A", seller: "Amazon.com", price: 10, priceText: "$10.00", url: "https://www.amazon.com/dp/B01", direct: true, retailerHost: "amazon.com", source: "serpapi", immersiveToken: "tok-secret" },
    { title: "B", seller: "Amazon.com - Seller", price: 11, priceText: "$11.00", url: "https://www.google.com/shopping/product/1", direct: false, retailerHost: "", source: "serpapi" },
    { title: "C", seller: "Walmart", price: 12, priceText: "$12.00", url: "https://www.walmart.com/ip/1", direct: true, retailerHost: "walmart.com", source: "serpapi" },
  ];
  out.present = presentOffers(offers, cfgAll).map((o) => ({ price: o.price, priceText: o.priceText, url: o.url, direct: o.direct, retailerHost: o.retailerHost, hasToken: "immersiveToken" in o }));

  console.log(JSON.stringify(out));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
