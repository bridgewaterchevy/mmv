// One Discover post, sized to fill the feed viewport: swipeable photos with dots, author chip,
// caption, vibe pill, like / share / overflow rail, and the "Shop this fit" pull-up bar.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Heart, Share2, MoreHorizontal, ChevronUp, Flag, Trash2, Link2, Sparkles, Images } from "lucide-react";
import { Avatar, type AvatarUser } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { apiJson, assetUrl } from "@/lib/queryClient";
import { copyText } from "@/lib/invite";
import { cn } from "@/lib/utils";
import { analysisStatusOf } from "@/lib/analysis";
import { REPORT_REASONS, VIBE_EMOJI, formatCount, isVibe, postUrl, timeAgo, toggleLike, vibeLabel, type PostView, type ReportReason } from "@/lib/discover";
import { findCachedPost, patchPost, removePost } from "@/lib/post-cache";
import { useGate } from "@/components/sign-in-prompt";

/** Avatar shape for a post author. */
export function authorAsUser(a: PostView["author"]): AvatarUser {
  return { id: a.id, name: a.name, color: a.color };
}

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name;
}

// ---------- like ----------
/** POST /api/posts/:id/like (toggle). Optimistic across every cache the post lives in; rolls back on error. */
export function useLikePost() {
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: number) => apiJson<{ likeCount: number; likedByMe: boolean }>("POST", `/api/posts/${id}/like`),
    onMutate: (id) => {
      const before = findCachedPost(id);
      patchPost(id, toggleLike);
      return { before };
    },
    onSuccess: (res, id) => {
      if (res && typeof res.likeCount === "number") patchPost(id, (p) => ({ ...p, likeCount: res.likeCount, likedByMe: !!res.likedByMe }));
    },
    onError: (e: Error, id, ctx) => {
      if (ctx?.before) patchPost(id, () => ctx.before!);
      toast({ title: e.message || "Couldn't save that like", variant: "destructive" });
    },
  });
}

// ---------- share link ----------
export async function sharePostLink(id: number): Promise<"copied" | "failed"> {
  return (await copyText(postUrl(id))) ? "copied" : "failed";
}

// ---------- the card ----------
export interface PostCardProps {
  post: PostView;
  /** True when this card is the one in view; drives eager image loading. */
  active?: boolean;
  onOpenShop: (post: PostView) => void;
  /** Vertical scroll container (the feed) so a downward pull on the shop bar can step back a post. */
  scrollerRef?: React.RefObject<HTMLElement | null>;
  /** Extra classes on the outer viewport-sized section (padding for the filter row / tab bar). */
  className?: string;
  /** Replace the top-left vibe pill with something else (e.g. a back button on the permalink). */
  topLeft?: React.ReactNode;
}

const SWIPE_UP_PX = 48;
const SWIPE_DOWN_PX = 64;

export function PostCard({ post, active = false, onOpenShop, scrollerRef, className, topLeft }: PostCardProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const gate = useGate();
  const like = useLikePost();
  const photos = post.photos.length ? post.photos : [];
  const n = photos.length;
  const stripRef = useRef<HTMLDivElement>(null);
  const [slide, setSlide] = useState(0);
  const [reportOpen, setReportOpen] = useState(false);
  const [unshareOpen, setUnshareOpen] = useState(false);
  const status = analysisStatusOf(post);
  const pieceCount = post.items?.length ?? 0;
  const mine = post.isMine || (!!user && user.id === post.author.id);

  useEffect(() => { setSlide(0); stripRef.current?.scrollTo({ left: 0 }); }, [post.id]);

  function onStripScroll() {
    const el = stripRef.current;
    if (!el || !el.clientWidth) return;
    const i = Math.max(0, Math.min(n - 1, Math.round(el.scrollLeft / el.clientWidth)));
    if (i !== slide) setSlide(i);
  }
  function goSlide(i: number) {
    const el = stripRef.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    setSlide(i);
  }

  const doLike = gate("like", () => like.mutate(post.id));

  async function doShare() {
    const r = await sharePostLink(post.id);
    if (r === "copied") toast({ title: "Link copied", description: "Anyone with it can see this fit, signed in or not." });
    else toast({ title: postUrl(post.id), description: "Couldn't copy automatically — long-press to copy." });
  }

  // Pull-up gesture on the shop bar: works for touch, pen and mouse (pointer events; touch-action pan-x keeps the
  // browser from turning the vertical drag into a feed scroll). A long pull down steps back one post instead.
  const drag = useRef<{ y: number; x: number; id: number } | null>(null);
  // A drag that moved more than a few px must not also fire the bar's click (mouse down+up on one element = click).
  const suppressClick = useRef(false);
  const [pull, setPull] = useState(0);
  function onBarDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    drag.current = { y: e.clientY, x: e.clientX, id: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onBarMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const dy = e.clientY - drag.current.y;
    setPull(Math.max(-72, Math.min(0, dy)));
  }
  function onBarUp(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    drag.current = null;
    setPull(0);
    if (!d) return;
    const dy = e.clientY - d.y;
    const dx = Math.abs(e.clientX - d.x);
    suppressClick.current = Math.abs(dy) > 8 || dx > 8;
    if (dy <= -SWIPE_UP_PX && dx < 80) onOpenShop(post);
    else if (dy >= SWIPE_DOWN_PX && dx < 80) scrollerRef?.current?.scrollBy({ top: -scrollerRef.current.clientHeight, behavior: "smooth" });
  }

  const vibe = post.vibe;

  return (
    <section
      className={cn("relative flex h-[100dvh] w-full shrink-0 snap-start snap-always flex-col px-3", className)}
      data-testid={`post-card-${post.id}`}
      data-post-id={post.id}
      data-active={active ? "true" : undefined}
      aria-label={`${post.author.name}'s fit`}
    >
      <article className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.25rem] border border-card-border bg-muted shadow-sm">
        {/* photos */}
        <div
          ref={stripRef}
          onScroll={onStripScroll}
          className="absolute inset-0 flex snap-x snap-mandatory overflow-x-auto overflow-y-hidden no-scrollbar"
          data-testid="strip-post-photos"
          data-active={slide}
          data-count={n}
          aria-roledescription="carousel"
        >
          {n === 0 ? (
            <div className="flex w-full shrink-0 items-center justify-center text-muted-foreground"><Images className="h-8 w-8" /></div>
          ) : photos.map((ph, i) => (
            <div key={ph.id} className="relative h-full w-full shrink-0 snap-center" data-testid={`slide-post-photo-${i}`} aria-hidden={i !== slide}>
              <img
                src={assetUrl(ph.url)}
                alt={`${post.author.name}'s fit, photo ${i + 1} of ${n}`}
                className="h-full w-full object-cover"
                loading={active || i === 0 ? "eager" : "lazy"}
                decoding="async"
                draggable={false}
              />
            </div>
          ))}
        </div>
        {/* soft scrims so white text reads on any photo */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/45 to-transparent" aria-hidden />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-black/75 via-black/35 to-transparent" aria-hidden />

        {/* top row: vibe pill (or back) + dots */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
          <div className="pointer-events-auto">
            {topLeft ?? (
              vibe ? (
                <Link
                  href={`/discover/${encodeURIComponent(vibe)}`}
                  className="inline-flex items-center gap-1 rounded-full bg-background/90 px-2.5 py-1 text-xs font-semibold text-foreground backdrop-blur hover-elevate"
                  data-testid={`pill-vibe-${vibe}`}
                >
                  <span aria-hidden>{isVibe(vibe) ? VIBE_EMOJI[vibe] : "✨"}</span> {vibeLabel(vibe)}
                </Link>
              ) : null
            )}
          </div>
          {n > 1 && (
            <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/35 px-2 py-1.5 backdrop-blur-sm" role="tablist" aria-label="Photos" data-testid="dots-post-photos">
              {photos.map((ph, i) => (
                <button
                  key={ph.id}
                  type="button"
                  role="tab"
                  aria-selected={i === slide}
                  aria-label={`Photo ${i + 1} of ${n}`}
                  onClick={() => goSlide(i)}
                  className={cn("h-1.5 rounded-full transition-all", i === slide ? "w-5 bg-white" : "w-1.5 bg-white/55")}
                  data-testid={`dot-post-photo-${i}`}
                />
              ))}
            </div>
          )}
        </div>

        {/* right rail */}
        <div className="absolute bottom-[7.25rem] right-3 flex flex-col items-center gap-3" data-testid="rail-post-actions">
          <button
            type="button"
            onClick={doLike}
            className={cn(
              "flex h-12 w-12 flex-col items-center justify-center rounded-full border backdrop-blur transition-colors active-elevate-2",
              post.likedByMe ? "border-primary/40 bg-primary text-primary-foreground" : "border-white/20 bg-black/35 text-white",
            )}
            aria-pressed={post.likedByMe}
            aria-label={post.likedByMe ? `Unlike (${post.likeCount})` : `Like (${post.likeCount})`}
            data-testid="button-like"
            data-liked={post.likedByMe ? "true" : "false"}
          >
            <Heart className={cn("h-5 w-5", post.likedByMe && "fill-current")} strokeWidth={2.2} />
            <span className="text-[10px] font-bold leading-none tabular-nums" data-testid="text-like-count">{formatCount(post.likeCount)}</span>
          </button>
          <button type="button" onClick={doShare} className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-black/35 text-white backdrop-blur active-elevate-2" aria-label="Copy link" data-testid="button-share-post">
            <Share2 className="h-5 w-5" strokeWidth={2} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 bg-black/35 text-white backdrop-blur active-elevate-2" aria-label="More" data-testid="button-post-more">
                <MoreHorizontal className="h-5 w-5" strokeWidth={2} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[11rem] rounded-xl" data-testid="menu-post-more">
              <DropdownMenuItem onSelect={doShare} data-testid="menu-copy-link"><Link2 className="h-4 w-4" /> Copy link</DropdownMenuItem>
              <DropdownMenuItem asChild data-testid="menu-view-profile">
                <Link href={`/u/${encodeURIComponent(post.author.handle)}`}><Avatar user={authorAsUser(post.author)} size="sm" className="h-4 w-4 text-[9px] ring-0" /> @{post.author.handle}</Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {mine ? (
                <DropdownMenuItem onSelect={() => setUnshareOpen(true)} className="text-destructive focus:text-destructive" data-testid="menu-unshare"><Trash2 className="h-4 w-4" /> Unshare</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={gate("report", () => setReportOpen(true))} data-testid="menu-report"><Flag className="h-4 w-4" /> Report</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* author + caption */}
        <div className="pointer-events-none absolute inset-x-0 bottom-[4.25rem] px-3 pb-2 pr-20 text-white">
          <Link href={`/u/${encodeURIComponent(post.author.handle)}`} className="pointer-events-auto inline-flex max-w-full items-center gap-2 rounded-full bg-black/30 py-1 pl-1 pr-3 backdrop-blur-sm active-elevate-2" data-testid="link-post-author">
            <Avatar user={authorAsUser(post.author)} size="sm" className="ring-white/40" />
            <span className="min-w-0 truncate text-sm font-semibold leading-none">
              {firstName(post.author.name)} <span className="font-normal text-white/75">@{post.author.handle}</span>
            </span>
            <span className="shrink-0 text-[11px] text-white/60" data-testid="text-post-age">· {timeAgo(post.createdAt)}</span>
          </Link>
          {post.caption && (
            <p className="mt-2 line-clamp-3 text-[15px] leading-snug drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]" data-testid="text-post-caption">{post.caption}</p>
          )}
        </div>

        {/* pull-up shop bar (mini sheet) */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onOpenShop(post); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenShop(post); } }}
          onPointerDown={onBarDown}
          onPointerMove={onBarMove}
          onPointerUp={onBarUp}
          onPointerCancel={onBarUp}
          className="absolute inset-x-0 bottom-0 select-none rounded-t-2xl border-t border-card-border bg-background/95 px-4 pb-3 pt-2 text-foreground backdrop-blur transition-transform duration-75 ease-out"
          style={{ transform: pull ? `translateY(${pull}px)` : undefined, touchAction: "pan-x" }}
          data-testid="button-shop-fit"
          aria-label="Shop this fit"
        >
          <span className="mx-auto mb-2 block h-1.5 w-10 rounded-full bg-muted-foreground/30" aria-hidden />
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-display text-base font-bold leading-tight">Shop this fit</p>
              <p className="truncate text-xs text-muted-foreground" data-testid="text-shop-fit-sub">
                {status === "pending" ? <span className="inline-flex items-center gap-1"><Sparkles className="h-3 w-3 animate-pulse text-primary" aria-hidden /> Reading this fit…</span>
                  : status === "failed" ? "Couldn't read the pieces"
                  : pieceCount ? `${pieceCount} ${pieceCount === 1 ? "piece" : "pieces"} · live prices` : "Pieces coming soon"}
              </p>
            </div>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"><ChevronUp className="h-4 w-4" strokeWidth={2.6} /></span>
          </div>
        </div>
      </article>

      <ReportDialog post={post} open={reportOpen} onOpenChange={setReportOpen} />
      <UnshareDialog post={post} open={unshareOpen} onOpenChange={setUnshareOpen} />
    </section>
  );
}

// ---------- report ----------
export function ReportDialog({ post, open, onOpenChange }: { post: PostView; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const m = useMutation({
    mutationFn: () => apiJson("POST", `/api/posts/${post.id}/report`, { reason }),
    onSuccess: () => { onOpenChange(false); setReason(null); toast({ title: "Thanks — we'll take a look", description: "Reports are reviewed by a human." }); },
    onError: (e: Error) => toast({ title: e.message || "Couldn't send that report", variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setReason(null); onOpenChange(o); }}>
      <DialogContent className="max-w-sm rounded-2xl" data-testid="dialog-report-post">
        <DialogHeader className="text-left">
          <DialogTitle className="font-display text-xl">Report this fit</DialogTitle>
          <DialogDescription>Tell us what's wrong. The author won't see who reported it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5" role="radiogroup" aria-label="Reason">
          {REPORT_REASONS.map((r) => (
            <button
              key={r.value}
              type="button"
              role="radio"
              aria-checked={reason === r.value}
              onClick={() => setReason(r.value)}
              className={cn("flex items-center justify-between rounded-xl border px-3 py-2.5 text-left text-sm hover-elevate", reason === r.value ? "border-primary bg-primary/10 font-semibold" : "border-border bg-card")}
              data-testid={`option-report-${r.value}`}
            >
              {r.label}
              {reason === r.value && <span className="h-2.5 w-2.5 rounded-full bg-primary" aria-hidden />}
            </button>
          ))}
        </div>
        <Button className="w-full" disabled={!reason || m.isPending} onClick={() => m.mutate()} data-testid="button-send-report">{m.isPending ? "Sending…" : "Send report"}</Button>
      </DialogContent>
    </Dialog>
  );
}

// ---------- unshare ----------
export function useUnsharePost(onDone?: (id: number) => void) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: number) => apiJson("DELETE", `/api/posts/${id}`),
    onSuccess: (_r, id) => { removePost(id); toast({ title: "Removed from Discover", description: "Your pick is still in your crew and closet." }); onDone?.(id); },
    onError: (e: Error) => toast({ title: e.message || "Couldn't unshare right now", variant: "destructive" }),
  });
}

export function UnshareDialog({ post, open, onOpenChange, onDone }: { post: PostView; open: boolean; onOpenChange: (o: boolean) => void; onDone?: () => void }) {
  const m = useUnsharePost(() => { onOpenChange(false); onDone?.(); });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-2xl" data-testid="dialog-unshare-post">
        <DialogHeader className="text-left">
          <DialogTitle className="font-display text-xl">Unshare this fit?</DialogTitle>
          <DialogDescription>It comes off Discover and your profile. Your crew still sees the pick.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)} data-testid="button-cancel-unshare">Keep it</Button>
          <Button variant="destructive" className="flex-1" disabled={m.isPending} onClick={() => m.mutate(post.id)} data-testid="button-confirm-unshare">{m.isPending ? "Removing…" : "Unshare"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
