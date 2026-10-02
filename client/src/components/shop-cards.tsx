// Shop cards for a pick's / post's garments: live offers from GET /api/picks/:id/prices or
// GET /api/posts/:id/prices (same shape). Shared by the session PickDrawer and the Discover
// "Shop this fit" sheet so the Buy/Shop treatment never drifts between the two.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, ChevronDown, ShoppingBag, Sparkles } from "lucide-react";
import type { GarmentItem } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatPrice, isDirect, isLowestPrice, offerSourceLabel, pickHighlightOffer, retailerHost, type PriceOffer } from "@/lib/offers";

// Offer shape + highlight rule live in @/lib/offers (pure, unit-testable).
export interface PricedItem extends GarmentItem {
  offers: PriceOffer[];
}
export interface PricesResponse {
  items: PricedItem[];
}

export const PRICES_STALE_MS = 10 * 60 * 1000;

/**
 * Fetches live offers once per resource (`["/api/picks", id, "prices"]` or `["/api/posts", id, "prices"]`).
 * Failures (route missing, provider down) degrade to "no offers" rather than an error state.
 */
export function usePrices(queryKey: readonly unknown[], enabled: boolean) {
  return useQuery<PricesResponse>({
    queryKey: queryKey as unknown[],
    enabled,
    staleTime: PRICES_STALE_MS,
    gcTime: PRICES_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** Align priced items to the garments by index; anything missing falls back to the garment's own links and no offers. */
export function mergePricedItems(items: GarmentItem[], prices: PricesResponse | undefined): PricedItem[] {
  return items.map((it, i) => {
    const p = prices?.items?.[i];
    return { ...it, links: Array.isArray(p?.links) && p.links.length ? p.links : it.links, offers: Array.isArray(p?.offers) ? p.offers : [] };
  });
}

function isAmazon(o: PriceOffer) {
  return /amazon/i.test(o.source) || /amazon/i.test(o.seller) || /amazon\./i.test(o.url) || /amazon\./i.test(retailerHost(o));
}

function OfferPrice({ offer, className }: { offer: PriceOffer; className?: string }) {
  const text = formatPrice(offer);
  if (text) return <span className={className}>{text}</span>;
  return <span className={cn("text-muted-foreground", className)}>{isAmazon(offer) ? "See price on Amazon" : "See price"}</span>;
}

function ShopLinks({ links, index }: { links: GarmentItem["links"]; index: number }) {
  if (!links.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium hover-elevate", l.label === "Compare prices" ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground")} data-testid={`link-shop-${index}-${l.label}`}>
          {l.label} <ExternalLink className="h-3 w-3" />
        </a>
      ))}
    </div>
  );
}

/** One garment: swatch + description + brand, cheapest offer with Buy, collapsible other prices, and the search/brand chips. */
export function ShopCard({ item, index, pickId, loading }: { item: PricedItem; index: number; pickId: number; loading: boolean }) {
  const [moreOpen, setMoreOpen] = useState(false);
  // Highlight rule: cheapest priced offer, unless it's a Google Shopping link and a retailer-direct offer sits within 10% of it.
  const cheapest = pickHighlightOffer(item.offers);
  const others = cheapest ? item.offers.filter((o) => o !== cheapest) : [];
  const cheapestPrice = cheapest ? formatPrice(cheapest) : null;
  const cheapestDirect = cheapest ? isDirect(cheapest) : false;
  // Only call it "Cheapest" when it really is; when the 10% rule promoted a direct offer, say so instead.
  const highlightLabel = cheapest && isLowestPrice(cheapest, item.offers) ? "Cheapest" : "Buy direct";

  return (
    <li className="rounded-xl border border-card-border bg-card p-3" data-testid={`card-item-${pickId}-${index}`}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full border border-border ring-2 ring-card" style={{ backgroundColor: item.colorHex }} role="img" aria-label={item.colorName} title={item.colorName} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold capitalize">
            {item.category}
            {item.brandGuess ? <span className="ml-1.5 rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium normal-case text-secondary-foreground">{item.brandGuess}</span> : null}
          </p>
          <p className="text-sm text-muted-foreground">{item.description}</p>
        </div>
      </div>

      {loading ? (
        <div className="mt-2.5 flex items-center gap-2.5 rounded-lg bg-muted/60 p-2" data-testid={`skeleton-prices-${index}`} aria-busy="true" aria-label="Loading prices">
          <Skeleton className="h-12 w-12 shrink-0 rounded-lg bg-muted-foreground/15" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3 bg-muted-foreground/15" />
            <Skeleton className="h-3 w-1/2 bg-muted-foreground/15" />
          </div>
          <Skeleton className="h-8 w-14 shrink-0 rounded-md bg-muted-foreground/15" />
        </div>
      ) : cheapest ? (
        <>
          <div className="mt-2.5 flex items-center gap-2.5 rounded-lg border border-primary/20 bg-primary/5 p-2" data-testid={`row-cheapest-${index}`}>
            {cheapest.thumbnail ? (
              <img src={cheapest.thumbnail} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-lg bg-muted object-cover" />
            ) : (
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><ShoppingBag className="h-5 w-5" /></span>
            )}
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 break-words text-sm leading-snug" data-testid={`text-cheapest-${index}`}>
                {cheapestPrice ? (
                  <><span className="font-semibold text-primary">{highlightLabel}: {cheapestPrice}</span> <span className="text-muted-foreground">at</span> <span className="font-medium">{cheapest.seller}</span></>
                ) : (
                  <><span className="font-medium">{cheapest.seller}</span> <span className="text-muted-foreground">· <OfferPrice offer={cheapest} /></span></>
                )}
              </p>
              <p className="truncate text-[11px] leading-tight text-muted-foreground" data-testid={`text-cheapest-source-${index}`}>{offerSourceLabel(cheapest)}</p>
              <p className="truncate text-xs text-muted-foreground" title={cheapest.title}>{cheapest.title}</p>
            </div>
            <Button asChild size="sm" className="shrink-0">
              <a href={cheapest.url} target="_blank" rel="noopener sponsored" data-testid={`button-buy-${index}`} data-direct={cheapestDirect ? "true" : "false"} aria-label={cheapestDirect ? `Buy at ${cheapest.seller}` : `Shop ${cheapest.seller} on Google Shopping`}>
                {cheapestDirect ? "Buy" : "Shop"} <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          </div>

          {others.length > 0 && (
            <Collapsible open={moreOpen} onOpenChange={setMoreOpen} className="mt-1.5">
              <CollapsibleTrigger asChild>
                <button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover-elevate" data-testid={`button-more-prices-${index}`} aria-expanded={moreOpen}>
                  More prices ({others.length}) <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", moreOpen && "rotate-180")} />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-1 divide-y divide-border rounded-lg border border-border" data-testid={`list-offers-${index}`}>
                  {others.map((o, j) => (
                    <li key={`${o.url}-${j}`}>
                      <a href={o.url} target="_blank" rel="noopener sponsored" className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-sm hover-elevate" data-testid={`link-offer-${index}-${j}`} data-direct={isDirect(o) ? "true" : "false"}>
                        <span className="min-w-0">
                          <span className="block truncate font-medium leading-snug">{o.seller}</span>
                          <span className="block truncate text-xs leading-snug text-muted-foreground">{o.title}</span>
                        </span>
                        <span className="flex max-w-[55%] shrink-0 flex-col items-end text-right">
                          <OfferPrice offer={o} className="text-sm font-semibold leading-snug" />
                          <span className="max-w-full truncate text-[10px] leading-tight text-muted-foreground" data-testid={`text-offer-source-${index}-${j}`}>{offerSourceLabel(o, { short: true })}</span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}

          <div className="mt-2"><ShopLinks links={item.links} index={index} /></div>
        </>
      ) : (
        <div className="mt-2">
          <ShopLinks links={item.links} index={index} />
          <p className="mt-2 text-xs text-muted-foreground" data-testid={`text-prices-soon-${index}`}>Live prices coming soon</p>
        </div>
      )}
    </li>
  );
}

/** Shop-card stand-ins shown while analysis is pending. `label` lets the Discover sheet say "Reading this fit…". */
export function ShopCardsShimmer({ label = "Reading the outfit…" }: { label?: string }) {
  return (
    <div data-testid="status-analysis-pending" aria-busy="true" aria-live="polite">
      <p className="mb-2 flex items-center gap-1.5 text-sm text-muted-foreground"><Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" aria-hidden /> {label}</p>
      <ul className="space-y-2" aria-hidden>
        {[0, 1].map((i) => (
          <li key={i} className="rounded-xl border border-card-border bg-card p-3">
            <div className="flex items-start gap-2.5">
              <span className="shimmer mt-0.5 h-5 w-5 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="shimmer h-3.5 w-1/3 rounded" />
                <div className="shimmer h-3 w-3/4 rounded" />
              </div>
            </div>
            <div className="mt-2.5 flex items-center gap-2.5 rounded-lg bg-muted/60 p-2">
              <div className="shimmer h-12 w-12 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="shimmer h-3.5 w-2/3 rounded" />
                <div className="shimmer h-3 w-1/2 rounded" />
              </div>
              <div className="shimmer h-8 w-14 shrink-0 rounded-md" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Small affiliate line under any shop-card list. */
export function AffiliateDisclosure({ className }: { className?: string }) {
  return (
    <p className={cn("mt-2 text-[11px] leading-snug text-muted-foreground", className)} data-testid="text-affiliate-disclosure">
      Affiliate links may earn MMV a commission at no extra cost to you. As an Amazon Associate, MMV earns from qualifying purchases.
    </p>
  );
}

/** Garment chips: colour dot + category, as a compact horizontal wrap. */
export function GarmentChips({ items, className, testId = "chips-garments" }: { items: GarmentItem[]; className?: string; testId?: string }) {
  if (!items.length) return null;
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)} data-testid={testId} aria-label={`${items.length} pieces`}>
      {items.map((it, i) => (
        <li key={`${it.category}-${i}`} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card py-1 pl-1.5 pr-2.5 text-xs font-medium capitalize" data-testid={`chip-garment-${i}`}>
          <span className="h-3.5 w-3.5 rounded-full border border-border" style={{ backgroundColor: it.colorHex }} aria-hidden />
          {it.category}
        </li>
      ))}
    </ul>
  );
}
