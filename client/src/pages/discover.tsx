// #/discover[/:vibe] — public, full-screen, snap-scrolling feed of shared fits. Renders without a token;
// like / report / follow ask for sign-in only when tapped.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Compass, Sparkles, RefreshCw, ChevronLeft } from "lucide-react";
import { Logo, TabBar } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { PostCard } from "@/components/post-card";
import { ShopFitSheet } from "@/components/shop-fit-sheet";
import { requireSignIn } from "@/components/sign-in-prompt";
import { useAuth } from "@/lib/auth";
import { apiJson } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { VIBES, VIBE_EMOJI, VIBE_LABEL, discoverPath, isVibe, type FeedPage, type FeedSort, type PostView, type Vibe } from "@/lib/discover";
import { feedKey } from "@/lib/post-cache";

const SORT_KEY = "mmv.discover.sort";
function readSort(): FeedSort {
  try { return sessionStorage.getItem(SORT_KEY) === "top" ? "top" : "new"; } catch { return "new"; }
}

/** Padding that keeps each post clear of the fixed filter row (top) and tab bar (bottom). */
export const FEED_CARD_PAD = "pt-[calc(env(safe-area-inset-top,0px)+3.5rem)] pb-[calc(env(safe-area-inset-bottom,0px)+5.75rem)]";
export const SOLO_CARD_PAD = "pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] pb-[calc(env(safe-area-inset-bottom,0px)+5.75rem)]";

export function useFeed(vibe: Vibe | null, sort: FeedSort) {
  return useInfiniteQuery<FeedPage, Error, { pages: FeedPage[]; pageParams: unknown[] }, readonly unknown[], string | null>({
    queryKey: feedKey(vibe, sort),
    queryFn: ({ pageParam }) => apiJson<FeedPage>("GET", discoverPath({ cursor: pageParam, vibe, sort })),
    initialPageParam: null,
    getNextPageParam: (last) => (last?.nextCursor ? last.nextCursor : undefined),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export default function DiscoverPage({ params }: { params: { vibe?: string } }) {
  const [, navigate] = useLocation();
  const vibe: Vibe | null = isVibe(params.vibe) ? params.vibe : null;
  const [sort, setSortState] = useState<FeedSort>(readSort);
  const setSort = (s: FeedSort) => { setSortState(s); try { sessionStorage.setItem(SORT_KEY, s); } catch { /* ignore */ } };
  const feed = useFeed(vibe, sort);
  const posts = useMemo(() => feed.data?.pages.flatMap((p) => p?.posts ?? []) ?? [], [feed.data]);
  const [shopPost, setShopPost] = useState<PostView | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  // Back to the top whenever the filter changes.
  useEffect(() => { scrollerRef.current?.scrollTo({ top: 0 }); setActive(0); }, [vibe, sort]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !el.clientHeight) return;
    const i = Math.max(0, Math.round(el.scrollTop / el.clientHeight));
    setActive((cur) => (cur === i ? cur : i));
    if (i >= posts.length - 2 && feed.hasNextPage && !feed.isFetchingNextPage) feed.fetchNextPage();
  }, [posts.length, feed]);

  // The shop sheet tracks the latest copy of its post (likes etc.) from the feed.
  const shopLive = shopPost ? posts.find((p) => p.id === shopPost.id) ?? shopPost : null;

  return (
    <div className="relative mx-auto w-full max-w-md bg-background md:border-x md:border-border/60">
      <FilterRow vibe={vibe} sort={sort} onVibe={(v) => navigate(v ? `/discover/${v}` : "/discover")} onSort={setSort} />

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="h-[100dvh] snap-y snap-mandatory overflow-y-auto overscroll-y-contain no-scrollbar"
        data-testid="feed-discover"
        data-active={active}
        data-count={posts.length}
        data-sort={sort}
        data-vibe={vibe ?? ""}
      >
        {feed.isLoading ? (
          <FeedSkeleton />
        ) : feed.isError ? (
          <FeedMessage
            icon={<RefreshCw className="h-6 w-6" />}
            title="Couldn't load Discover"
            body={feed.error?.message || "Check your connection and try again."}
            action={<Button onClick={() => feed.refetch()} data-testid="button-feed-retry"><RefreshCw className="h-4 w-4" /> Try again</Button>}
          />
        ) : posts.length === 0 ? (
          <EmptyFeed vibe={vibe} />
        ) : (
          <>
            {posts.map((p, i) => (
              <PostCard key={p.id} post={p} active={i === active} onOpenShop={setShopPost} scrollerRef={scrollerRef} className={FEED_CARD_PAD} />
            ))}
            {feed.isFetchingNextPage && (
              <div className="flex h-16 snap-start items-center justify-center gap-2 text-xs text-muted-foreground" data-testid="status-feed-loading-more" aria-busy="true">
                <Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" /> Loading more fits…
              </div>
            )}
          </>
        )}
      </div>

      <TabBar tone="overlay" />
      <ShopFitSheet post={shopLive} onClose={() => setShopPost(null)} />
    </div>
  );
}

// ---------- filter row ----------
function FilterRow({ vibe, sort, onVibe, onSort }: { vibe: Vibe | null; sort: FeedSort; onVibe: (v: Vibe | null) => void; onSort: (s: FeedSort) => void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  // Keep the selected chip in view when arriving via a deep link.
  useEffect(() => {
    const el = rowRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    el?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [vibe]);
  return (
    <div className="fixed inset-x-0 top-0 z-20 mx-auto w-full max-w-md pt-[env(safe-area-inset-top,0px)]" data-testid="row-feed-filters">
      <div className="flex items-center gap-2 px-3 py-2">
        <Link href="/discover" className="shrink-0" aria-label="Discover"><Logo withWord={false} /></Link>
        <div ref={rowRef} className="flex min-w-0 flex-1 snap-x items-center gap-1.5 overflow-x-auto no-scrollbar" role="group" aria-label="Vibe">
          <VibeChip label="All" emoji={<Compass className="h-3 w-3" />} active={vibe === null} onClick={() => onVibe(null)} testId="chip-vibe-all" />
          {VIBES.map((v) => (
            <VibeChip key={v} label={VIBE_LABEL[v]} emoji={<span aria-hidden>{VIBE_EMOJI[v]}</span>} active={vibe === v} onClick={() => onVibe(vibe === v ? null : v)} testId={`chip-vibe-${v}`} />
          ))}
        </div>
        <div className="flex shrink-0 rounded-full bg-muted p-0.5 text-xs font-semibold" role="radiogroup" aria-label="Sort" data-testid="toggle-feed-sort">
          {(["new", "top"] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={sort === s}
              onClick={() => onSort(s)}
              className={cn("rounded-full px-2.5 py-1 transition", sort === s ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}
              data-testid={`button-sort-${s}`}
            >
              {s === "new" ? "New" : "Top"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function VibeChip({ label, emoji, active, onClick, testId }: { label: string; emoji: React.ReactNode; active: boolean; onClick: () => void; testId: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex shrink-0 snap-start items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold transition hover-elevate",
        active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground",
      )}
      data-testid={testId}
    >
      {emoji} {label}
    </button>
  );
}

// ---------- states ----------
function FeedSkeleton() {
  return (
    <section className={cn("flex h-[100dvh] flex-col px-3", FEED_CARD_PAD)} data-testid="skeleton-feed" aria-busy="true">
      <div className="relative flex-1 overflow-hidden rounded-[1.25rem] border border-card-border shimmer">
        <div className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-background/95 px-4 pb-3 pt-2">
          <span className="mx-auto mb-2 block h-1.5 w-10 rounded-full bg-muted-foreground/30" />
          <div className="h-4 w-28 rounded bg-muted" />
          <div className="mt-1.5 h-3 w-40 rounded bg-muted" />
        </div>
      </div>
    </section>
  );
}

function FeedMessage({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <section className={cn("flex h-[100dvh] flex-col px-3", FEED_CARD_PAD)}>
      <div className="flex flex-1 flex-col items-center justify-center rounded-[1.25rem] border border-dashed border-border bg-card/60 p-8 text-center">
        <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">{icon}</span>
        <p className="font-display text-xl font-bold">{title}</p>
        <p className="mt-1 max-w-[16rem] text-sm text-muted-foreground">{body}</p>
        {action && <div className="mt-5">{action}</div>}
      </div>
    </section>
  );
}

function EmptyFeed({ vibe }: { vibe: Vibe | null }) {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  function shareFirst() {
    if (!user) return requireSignIn("share");
    navigate("/");
  }
  return (
    <section className={cn("flex h-[100dvh] flex-col px-3", FEED_CARD_PAD)} data-testid="empty-feed">
      <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden rounded-[1.25rem] border border-card-border bg-card p-8 text-center">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/10" aria-hidden />
        <div className="pointer-events-none absolute -bottom-20 -left-12 h-56 w-56 rounded-full bg-accent" aria-hidden />
        <span className="relative mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground"><Compass className="h-7 w-7" /></span>
        <p className="relative font-display text-2xl font-bold leading-tight">{vibe ? `No ${VIBE_LABEL[vibe].toLowerCase()} fits yet` : "Discover is quiet"}</p>
        <p className="relative mt-2 max-w-[17rem] text-sm text-muted-foreground">
          {vibe ? "Be the first to post one. Share a pick from any crew and tag the vibe." : "Fits your crews share land here, with every piece priced. Be the first."}
        </p>
        <Button size="lg" className="relative mt-6" onClick={shareFirst} data-testid="button-share-first-fit">
          <Sparkles className="h-4 w-4" /> Share your first fit
        </Button>
        {vibe && (
          <Link href="/discover" className="relative mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary" data-testid="link-feed-all">
            <ChevronLeft className="h-4 w-4" /> See all vibes
          </Link>
        )}
      </div>
    </section>
  );
}
