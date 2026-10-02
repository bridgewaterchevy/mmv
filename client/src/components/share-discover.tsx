// "Share to Discover" from the owner's pick in the session drawer:
//   POST /api/picks/:id/share { caption, vibe, photoIds } → 201 PostView
// then a "Shared" state with "View on Discover" and "Unshare" (DELETE /api/posts/:id).
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Check, Compass, ExternalLink, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiJson, assetUrl } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { analysisStatusOf, photosOf, type PickWithAnalysis } from "@/lib/analysis";
import { CAPTION_MAX, VIBES, VIBE_EMOJI, VIBE_LABEL, isVibe, type PostView, type Vibe } from "@/lib/discover";
import { prependPost } from "@/lib/post-cache";
import { useUnsharePost } from "@/components/post-card";

/** Best-guess vibe from the crew's activity so the picker starts on something sensible. */
export function vibeForActivity(activity: string | null | undefined): Vibe {
  const a = (activity ?? "").toLowerCase();
  if (/run/.test(a)) return "run";
  if (/pickle|tennis/.test(a)) return "pickleball";
  if (/golf/.test(a)) return "golf";
  if (/gym|crossfit|yoga|pilates|cycl/.test(a)) return "gym";
  if (/date/.test(a)) return "date-night";
  if (/girls/.test(a)) return "girls-night";
  if (/guys/.test(a)) return "guys-night";
  if (/brunch/.test(a)) return "brunch";
  if (/trip|travel/.test(a)) return "travel";
  return "other";
}

/** A pick that the server may already have shared (optional fields so older servers still type-check). */
type SharedPick = PickWithAnalysis & { postId?: number | null; post?: { id: number } | null };

function sharedPostIdOf(pick: SharedPick): number | null {
  if (typeof pick.postId === "number") return pick.postId;
  if (pick.post && typeof pick.post.id === "number") return pick.post.id;
  return null;
}

export function ShareToDiscover({ pick, activity, className }: { pick: PickWithAnalysis; activity?: string | null; className?: string }) {
  const [open, setOpen] = useState(false);
  const [postId, setPostId] = useState<number | null>(() => sharedPostIdOf(pick as SharedPick));
  useEffect(() => { setPostId(sharedPostIdOf(pick as SharedPick)); }, [pick.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const unshare = useUnsharePost(() => setPostId(null));
  const pending = analysisStatusOf(pick) === "pending";

  if (postId !== null) {
    return (
      <div className={cn("flex items-center justify-between gap-3 rounded-xl border border-accent bg-accent/60 px-3 py-2.5", className)} data-testid="status-shared-discover" data-post-id={postId}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-foreground text-accent"><Check className="h-4 w-4" strokeWidth={2.6} /></span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-accent-foreground">Shared to Discover</p>
            <Link href={`/p/${postId}`} className="inline-flex items-center gap-1 text-xs font-medium text-accent-foreground underline-offset-2 hover:underline" data-testid="link-view-on-discover">
              View on Discover <ExternalLink className="h-3 w-3" />
            </Link>
          </div>
        </div>
        <Button size="sm" variant="ghost" className="shrink-0 text-destructive" disabled={unshare.isPending} onClick={() => unshare.mutate(postId)} data-testid="button-unshare-discover">
          <Trash2 className="h-3.5 w-3.5" /> {unshare.isPending ? "Removing…" : "Unshare"}
        </Button>
      </div>
    );
  }

  return (
    <div className={className}>
      <Button variant="outline" className="w-full" onClick={() => setOpen(true)} data-testid="button-share-discover">
        <Compass className="h-4 w-4 text-primary" /> Share to Discover
      </Button>
      <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
        {pending ? "Public once we've read the pieces — you can post now and the shop list fills in." : "Anyone can see shared fits and shop the pieces. Your crew notes stay private."}
      </p>
      <ShareDiscoverDialog pick={pick} open={open} onOpenChange={setOpen} defaultVibe={vibeForActivity(activity)} onShared={(p) => { setPostId(p.id); setOpen(false); }} />
    </div>
  );
}

export function ShareDiscoverDialog({ pick, open, onOpenChange, defaultVibe, onShared }: { pick: PickWithAnalysis; open: boolean; onOpenChange: (o: boolean) => void; defaultVibe: Vibe; onShared: (post: PostView) => void }) {
  const { toast } = useToast();
  const photos = photosOf(pick).filter((ph) => !ph.optimistic);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(photos.map((ph) => ph.id)));
  const [caption, setCaption] = useState("");
  const [vibe, setVibe] = useState<Vibe>(defaultVibe);

  // Fresh dialog each time it opens: all photos on, caption cleared, vibe back to the crew's guess.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(photosOf(pick).filter((ph) => !ph.optimistic).map((ph) => ph.id)));
    setCaption(pick.note ?? "");
    setVibe(isVibe(defaultVibe) ? defaultVibe : "other");
  }, [open, pick.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const share = useMutation({
    mutationFn: () => {
      // Legacy single-photo picks have a synthetic photo (id 0) that the server doesn't know; let it default to all.
      const realIds = photos.filter((ph) => !ph.synthetic && selected.has(ph.id)).map((ph) => ph.id);
      const body: { caption: string; vibe: Vibe; photoIds?: number[] } = { caption: caption.trim(), vibe };
      if (photos.some((ph) => !ph.synthetic)) body.photoIds = realIds;
      return apiJson<PostView>("POST", `/api/picks/${pick.id}/share`, body);
    },
    onSuccess: (post) => {
      prependPost(post);
      toast({ title: "Shared to Discover", description: "Anyone can see it now. Likes bump it up the Top feed." });
      onShared(post);
    },
    onError: (e: Error) => toast({ title: e.message || "Couldn't share right now", variant: "destructive" }),
  });

  function toggle(id: number) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) { if (next.size > 1) next.delete(id); }
      else next.add(id);
      return next;
    });
  }

  const remaining = CAPTION_MAX - caption.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-2xl" data-testid="dialog-share-discover">
        <DialogHeader className="text-left">
          <DialogTitle className="font-display text-xl">Share to Discover</DialogTitle>
          <DialogDescription>Pick which photos go public, add a line, tag the vibe.</DialogDescription>
        </DialogHeader>

        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Photos <span className="font-normal normal-case tracking-normal">· {selected.size} of {photos.length} public</span></p>
          <div className="-mx-6 flex snap-x gap-2 overflow-x-auto px-6 pb-1 no-scrollbar" data-testid="strip-share-photos">
            {photos.map((ph, i) => {
              const on = selected.has(ph.id);
              return (
                <button
                  key={ph.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  aria-label={`Photo ${i + 1}${on ? ", public" : ", hidden"}`}
                  onClick={() => toggle(ph.id)}
                  className={cn("relative aspect-[3/4] w-20 shrink-0 snap-start overflow-hidden rounded-xl bg-muted ring-2 ring-offset-2 ring-offset-background transition", on ? "ring-primary" : "ring-transparent")}
                  data-testid={`toggle-share-photo-${i}`}
                  data-on={on ? "true" : "false"}
                >
                  <img src={assetUrl(ph.url)} alt="" className={cn("h-full w-full object-cover transition", !on && "opacity-40 grayscale")} draggable={false} />
                  <span className={cn("absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full text-white", on ? "bg-primary" : "bg-black/50")} aria-hidden>
                    {on && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <label htmlFor="share-caption" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Caption</label>
            <span className={cn("text-[11px] tabular-nums", remaining < 15 ? "text-primary" : "text-muted-foreground")} data-testid="text-caption-count">{remaining}</span>
          </div>
          <Textarea id="share-caption" value={caption} onChange={(e) => setCaption(e.target.value.slice(0, CAPTION_MAX))} maxLength={CAPTION_MAX} rows={2} placeholder="Sage set, white Metcons. Comfortable enough for burpees." className="min-h-[3.25rem] resize-none rounded-xl" data-testid="input-share-caption" />
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Vibe</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Vibe">
            {VIBES.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={vibe === v}
                onClick={() => setVibe(v)}
                className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium hover-elevate", vibe === v ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground")}
                data-testid={`option-vibe-${v}`}
              >
                <span aria-hidden>{VIBE_EMOJI[v]}</span> {VIBE_LABEL[v]}
              </button>
            ))}
          </div>
        </div>

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> The pieces and where to buy them come along; crew notes and reactions don't.</p>
        <Button size="lg" className="w-full" disabled={share.isPending || selected.size === 0} onClick={() => share.mutate()} data-testid="button-post-discover">
          {share.isPending ? "Posting…" : "Post to Discover"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
