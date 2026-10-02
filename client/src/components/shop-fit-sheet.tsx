// "Shop this fit" bottom sheet for a Discover post: garment chips, palette and the shop cards for
// GET /api/posts/:id/prices — the same ShopCard / shimmer treatment as the session PickDrawer.
import { Tag } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Avatar, Swatches } from "@/components/shell";
import { AffiliateDisclosure, GarmentChips, ShopCard, ShopCardsShimmer, mergePricedItems, usePrices } from "@/components/shop-cards";
import { analysisStatusOf } from "@/lib/analysis";
import { vibeLabel, type PostView } from "@/lib/discover";
import { postPricesKey } from "@/lib/post-cache";
import { authorAsUser, firstName } from "@/components/post-card";

export function ShopFitSheet({ post, onClose }: { post: PostView | null; onClose: () => void }) {
  const status = post ? analysisStatusOf(post) : "ready";
  const items = post?.items ?? [];
  const prices = usePrices(postPricesKey(post?.id ?? 0), !!post && status === "ready" && items.length > 0);
  const priced = mergePricedItems(items, prices.data);

  return (
    <Drawer open={!!post} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DrawerContent className="mx-auto max-h-[88dvh] max-w-md" data-testid="sheet-shop-fit">
        {post && (
          <div className="overflow-y-auto px-4 pb-8">
            <DrawerHeader className="px-0 text-left">
              <DrawerTitle className="flex items-center gap-2 font-display text-xl">
                <Avatar user={authorAsUser(post.author)} size="sm" /> Shop {post.isMine ? "your" : `${firstName(post.author.name)}'s`} fit
              </DrawerTitle>
              <DrawerDescription className="text-sm text-muted-foreground">
                {post.vibe ? `${vibeLabel(post.vibe)} · ` : ""}
                {status === "pending" ? "We're still reading the pieces." : items.length ? `${items.length} ${items.length === 1 ? "piece" : "pieces"} spotted. Prices update live.` : "No pieces to shop yet."}
              </DrawerDescription>
            </DrawerHeader>

            {status === "pending" ? (
              <span className="inline-flex -space-x-1.5" aria-hidden>
                {[0, 1, 2].map((i) => <span key={i} className="shimmer h-5 w-5 rounded-full ring-2 ring-card" style={{ animationDelay: `${i * 120}ms` }} />)}
              </span>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {post.palette.length > 0 && <Swatches colors={post.palette} />}
                <GarmentChips items={items} testId="chips-post-garments" />
              </div>
            )}

            <h3 className="mb-2 mt-5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><Tag className="h-3.5 w-3.5" /> Where to buy</h3>
            {status === "pending" ? (
              <ShopCardsShimmer label="Reading this fit…" />
            ) : status === "failed" ? (
              <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground" data-testid="status-analysis-failed">We couldn't read the pieces in this fit. You can still enjoy the look.</p>
            ) : items.length === 0 ? (
              <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground" data-testid="text-no-items">No shoppable pieces found in this one.</p>
            ) : (
              <>
                <ul className="space-y-2" data-testid="list-shop-items">
                  {priced.map((it, i) => (
                    <ShopCard key={`${post.id}-${i}`} item={it} index={i} pickId={post.id} loading={prices.isLoading} />
                  ))}
                </ul>
                <AffiliateDisclosure />
              </>
            )}
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}
