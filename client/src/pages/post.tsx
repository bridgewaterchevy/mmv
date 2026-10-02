// #/p/:id — one shared fit (public). Same card and shop sheet as the feed, with a back button where the vibe pill sits.
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Compass } from "lucide-react";
import { TabBar } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { PostCard } from "@/components/post-card";
import { ShopFitSheet } from "@/components/shop-fit-sheet";
import { errorStatus } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { VIBE_EMOJI, isVibe, vibeLabel, type PostView } from "@/lib/discover";
import { postKey } from "@/lib/post-cache";
import { SOLO_CARD_PAD } from "@/pages/discover";

export default function PostPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  const q = useQuery<PostView>({ queryKey: postKey(id), enabled: Number.isFinite(id) });
  const [shopOpen, setShopOpen] = useState(false);
  const [, navigate] = useLocation();

  function back() {
    if (window.history.length > 1 && document.referrer !== "") window.history.back();
    else navigate("/discover");
  }

  const backButton = (
    <button type="button" onClick={back} className="inline-flex items-center gap-1 rounded-full bg-background/90 py-1 pl-1.5 pr-3 text-xs font-semibold text-foreground backdrop-blur hover-elevate" data-testid="button-post-back" aria-label="Back to Discover">
      <ChevronLeft className="h-4 w-4" />
      {q.data?.vibe ? <><span aria-hidden>{isVibe(q.data.vibe) ? VIBE_EMOJI[q.data.vibe] : "✨"}</span> {vibeLabel(q.data.vibe)}</> : "Discover"}
    </button>
  );

  return (
    <div className="relative mx-auto w-full max-w-md bg-background md:border-x md:border-border/60" data-testid="page-post">
      <div className="h-[100dvh] overflow-y-auto overscroll-y-contain no-scrollbar">
        {q.isLoading ? (
          <section className={cn("flex h-[100dvh] flex-col px-3", SOLO_CARD_PAD)} aria-busy="true" data-testid="skeleton-post">
            <div className="flex-1 rounded-[1.25rem] border border-card-border shimmer" />
          </section>
        ) : !q.data ? (
          <section className={cn("flex h-[100dvh] flex-col px-3", SOLO_CARD_PAD)} data-testid="post-not-found">
            <div className="flex flex-1 flex-col items-center justify-center rounded-[1.25rem] border border-dashed border-border bg-card/60 p-8 text-center">
              <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-muted-foreground"><Compass className="h-6 w-6" /></span>
              <p className="font-display text-xl font-bold">{errorStatus(q.error) === 404 ? "This fit was unshared" : "This fit isn't available"}</p>
              <p className="mt-1 max-w-[16rem] text-sm text-muted-foreground">{errorStatus(q.error) === 404 ? "The author took it off Discover." : q.error?.message || "Check your connection and try again."}</p>
              <Button asChild className="mt-5"><Link href="/discover" data-testid="link-back-discover"><Compass className="h-4 w-4" /> Browse Discover</Link></Button>
            </div>
          </section>
        ) : (
          <PostCard post={q.data} active onOpenShop={() => setShopOpen(true)} className={SOLO_CARD_PAD} topLeft={backButton} />
        )}
      </div>
      <TabBar tone="overlay" />
      <ShopFitSheet post={shopOpen && q.data ? q.data : null} onClose={() => setShopOpen(false)} />
    </div>
  );
}
