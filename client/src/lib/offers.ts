// Pure helpers for the shop-card offer list (GET /api/picks/:id/prices). No React, no fetch — keep it unit-testable.

/**
 * One merchant offer for a garment.
 * `price` is null when the provider can't expose it (e.g. Amazon without PA-API).
 * `direct` / `retailerHost` are optional so an older server (which omits them) still renders:
 * undefined → treated as `direct: false`, `retailerHost: ""` (i.e. the url is a Google Shopping page).
 */
export interface PriceOffer {
  title: string;
  seller: string;
  price: number | null;
  priceText: string | null;
  url: string;
  thumbnail?: string | null;
  source: string;
  /** true = `url` is the retailer's own product page; false/undefined = Google Shopping page. */
  direct?: boolean;
  /** e.g. "lululemon.com"; "" or undefined when unknown / google. */
  retailerHost?: string;
}

/** Non-direct offers may be more than this fraction pricier before we stop preferring a direct one. */
export const DIRECT_PREFERENCE_TOLERANCE = 0.1;

export function isDirect(o: PriceOffer): boolean {
  return o.direct === true;
}

export function retailerHost(o: PriceOffer): string {
  return (o.retailerHost ?? "").trim();
}

/** Label shown under the seller / price: the retailer host for direct offers, otherwise where the link really goes. */
export function offerSourceLabel(o: PriceOffer, opts: { short?: boolean } = {}): string {
  if (isDirect(o)) return retailerHost(o) || "retailer site";
  return opts.short ? "Google" : "via Google Shopping";
}

export function hasPrice(o: PriceOffer): o is PriceOffer & { price: number } {
  return typeof o.price === "number" && Number.isFinite(o.price);
}

export function formatPrice(o: PriceOffer): string | null {
  if (o.priceText) return o.priceText;
  if (hasPrice(o)) return Number.isInteger(o.price) ? `$${o.price}` : `$${o.price.toFixed(2)}`;
  return null;
}

/**
 * Choose the offer to highlight with the Buy/Shop button.
 *
 * Rule:
 *  1. Only offers with a numeric price compete; if none has one, fall back to the first offer (or null when empty).
 *  2. Take the cheapest priced offer (first one wins ties — offers arrive cheapest-first).
 *  3. If that cheapest offer is NOT direct (a Google Shopping page) but a direct retailer offer exists priced
 *     within 10% of it (direct.price <= cheapest.price * 1.10), highlight the cheapest such direct offer instead.
 *     The cheaper non-direct offer then shows up in "More prices".
 *
 * Examples (seller → price, D = direct):
 *  - [Google $11.99, Old Navy $12.00 D, Lululemon $98 D, Amazon null]  → Old Navy  ($12.00 ≤ $13.19)
 *  - [Google $11.99, Old Navy $13.50 D]                               → Google    ($13.50 > $13.19, too pricey)
 *  - [Lululemon $48 D, Poshmark $52.50]                               → Lululemon (cheapest is already direct)
 *  - [Google $20, Nike $22 D, Zappos $21 D]                           → Zappos    (cheapest direct within 10%)
 *  - [Amazon null D]                                                  → Amazon    (no priced offers → first)
 *  - []                                                               → null
 */
export function pickHighlightOffer(offers: readonly PriceOffer[]): PriceOffer | null {
  if (!offers.length) return null;
  const priced = offers.filter(hasPrice);
  if (!priced.length) return offers[0];

  let cheapest = priced[0];
  for (const o of priced) if (o.price < cheapest.price) cheapest = o;
  if (isDirect(cheapest)) return cheapest;

  const ceiling = cheapest.price * (1 + DIRECT_PREFERENCE_TOLERANCE);
  let bestDirect: (PriceOffer & { price: number }) | null = null;
  for (const o of priced) {
    if (!isDirect(o) || o.price > ceiling) continue;
    if (!bestDirect || o.price < bestDirect.price) bestDirect = o;
  }
  return bestDirect ?? cheapest;
}

/** True when `o` is the lowest-priced offer in the list (ties count), so the UI may call it "Cheapest". */
export function isLowestPrice(o: PriceOffer, offers: readonly PriceOffer[]): boolean {
  if (!hasPrice(o)) return false;
  return offers.filter(hasPrice).every((x) => x.price >= o.price);
}
