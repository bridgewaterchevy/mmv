import type { GarmentItem, Offer } from "@shared/schema";

/**
 * Affiliate link wrapping. Applied at RESPONSE time (storage.pickView and the prices route), never
 * at storage time, so keys can be added or rotated later without re-processing stored picks.
 *
 * Env (all optional; with none set every url is returned unchanged):
 *   AMAZON_ASSOCIATES_TAG  e.g. "mmv-20". Added/replaced as ?tag= on amazon.* hosts.
 *     https://affiliate-program.amazon.com/help/operating/agreement
 *   SOVRN_API_KEY          Sovrn Commerce (ex-VigLink) site API key. Non-Amazon retailer links are
 *     wrapped with the Redirect API:  https://redirect.viglink.com?key=<KEY>&u=<encoded url>
 *     Verified against https://developer.sovrn.com/reference/building-monetized-urls (2026-01):
 *     required params are `key` and `u` (URL-encoded destination); optional `cuid`, `utm_*`, `cp`,
 *     `fbu`, `bf`. The legacy `type=api` / `&opt=true` params are NOT in the current Redirect API
 *     reference, so they are omitted. A 302 goes to the monetised url, or to the original url
 *     unchanged if the merchant is not in Sovrn's network. Same format on the knowledge base:
 *     https://knowledge.sovrn.com/kb/create-links-in-commerce
 */

const SOVRN_REDIRECT = "https://redirect.viglink.com";

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** amazon.com, www.amazon.co.uk, smile.amazon.de, amzn.to ... */
export function isAmazonHost(host: string | null): boolean {
  if (!host) return false;
  return /(^|\.)amazon\.[a-z.]+$/.test(host) || /(^|\.)amzn\.(to|com)$/.test(host);
}
export function isAmazonUrl(url: string): boolean {
  return isAmazonHost(hostOf(url));
}

/** google.* search/shopping pages are not retailers; wrapping them earns nothing and breaks nothing, so skip. */
function isSearchEngine(host: string): boolean {
  return /(^|\.)google\.[a-z.]+$/.test(host) || /(^|\.)bing\.com$/.test(host);
}

export interface AffiliateConfig {
  amazonTag?: string;
  sovrnKey?: string;
}

function configFromEnv(): AffiliateConfig {
  return {
    amazonTag: process.env.AMAZON_ASSOCIATES_TAG?.trim() || undefined,
    sovrnKey: process.env.SOVRN_API_KEY?.trim() || undefined,
  };
}

export function wrapLink(url: string, cfg: AffiliateConfig = configFromEnv()): string {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return url;
  const host = hostOf(url);
  if (!host) return url;

  if (isAmazonHost(host)) {
    if (!cfg.amazonTag) return url;
    const u = new URL(url);
    u.searchParams.set("tag", cfg.amazonTag);
    return u.toString();
  }

  if (cfg.sovrnKey && !isSearchEngine(host) && host !== "redirect.viglink.com") {
    return `${SOVRN_REDIRECT}?key=${encodeURIComponent(cfg.sovrnKey)}&u=${encodeURIComponent(url)}`;
  }
  return url;
}

export function wrapItemLinks<T extends GarmentItem>(item: T, cfg?: AffiliateConfig): T {
  const links = Array.isArray(item.links) ? item.links.map((l) => ({ ...l, url: wrapLink(l.url, cfg) })) : [];
  return { ...item, links };
}

export function wrapItems<T extends GarmentItem>(items: T[], cfg?: AffiliateConfig): T[] {
  return items.map((it) => wrapItemLinks(it, cfg));
}

/**
 * Prepare offers for the client: wrap urls, and hide Amazon prices.
 * Amazon Associates Program Policies: a site may only show Amazon prices if Amazon serves the link
 * or the data comes from PA-API / Creators API (https://affiliate-program.amazon.com/help/operating/policies).
 * Our prices come from Google Shopping providers, so for Amazon offers we null the number.
 */
export function presentOffers(offers: Offer[], cfg?: AffiliateConfig): Offer[] {
  const out = offers.map((o) => {
    const amazon = isAmazonUrl(o.url) || /\bamazon\b/i.test(o.seller);
    return {
      ...o,
      url: wrapLink(o.url, cfg),
      price: amazon ? null : o.price,
      priceText: amazon ? "See price on Amazon" : o.priceText,
    };
  });
  // Priced offers first (already ascending), unpriced/masked ones after. Stable sort keeps provider order otherwise.
  return out.sort((a, b) => Number(a.price == null) - Number(b.price == null));
}
