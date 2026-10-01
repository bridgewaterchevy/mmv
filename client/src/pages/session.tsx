import { useEffect, useRef, useState } from "react";
import { useQuery, useQueries, useMutation } from "@tanstack/react-query";
import { Camera, Lock, Unlock, ExternalLink, Sparkles, Trash2, Send, Tag, ChevronDown, ShoppingBag, RefreshCw } from "lucide-react";
import type { SessionView, PickView, PublicUser, GarmentItem } from "@shared/schema";
import { Page, Avatar, Swatches } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiJson, apiUpload, assetUrl, errorStatus, queryClient } from "@/lib/queryClient";
import { PhotoSourcePicker, UNSUPPORTED_PHOTO_MESSAGE } from "@/components/photo-picker";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { formatDate, matchScore, type MatchLevel } from "@/lib/color";
import { cn } from "@/lib/utils";
import { formatPrice, isDirect, isLowestPrice, offerSourceLabel, pickHighlightOffer, retailerHost, type PriceOffer } from "@/lib/offers";
import { downscaleForUpload } from "@/lib/image";
import { ANALYSIS_POLL_MS, analysisStatusOf, type PickWithAnalysis } from "@/lib/analysis";

const EMOJIS = ["🔥", "😍", "👯‍♀️", "✅"];

export default function SessionPage({ params }: { params: { id: string } }) {
  const id = Number(params.id);
  const q = useQuery<SessionView>({ queryKey: ["/api/sessions", id], refetchInterval: 15_000 });
  if (q.isLoading) return <Page title=" " back="/"><SessionSkeleton /></Page>;
  if (!q.data) return <Page title="Not found" back="/"><p className="text-sm text-muted-foreground">This day isn't available.</p></Page>;
  const s = q.data;
  return (
    <Page title={s.crew.name} subtitle={formatDate(s.date)} back={`/crews/${s.crewId}`}>
      <SessionBody session={s} queryKey={["/api/sessions", id]} />
    </Page>
  );
}

export function SessionSkeleton() {
  return (
    <>
      <Skeleton className="mb-3 h-24 rounded-2xl" />
      <div className="grid grid-cols-2 gap-3"><Skeleton className="aspect-[3/4] rounded-2xl" /><Skeleton className="aspect-[3/4] rounded-2xl" /></div>
    </>
  );
}

// ---------- async analysis: poll GET /api/picks/:id while pending ----------
/**
 * For every pick whose analysis is still pending, poll GET /api/picks/:id every 2.5 s and overlay
 * the fresher analysis fields (status, items, palette, error) on the session's copy. Everything
 * else (reactions, locked) keeps coming from the session so we never show stale social state.
 * When a poll settles (ready/failed) we call `onSettled` once so the caller can refetch the session
 * and the match meter catches up.
 */
function useLivePicks(picks: PickView[], sessionUpdatedAt: number, onSettled: (pick: PickWithAnalysis) => void): PickWithAnalysis[] {
  const results = useQueries({
    queries: picks.map((p) => ({
      queryKey: ["/api/picks", p.id] as const,
      enabled: analysisStatusOf(p) === "pending",
      staleTime: 0,
      refetchInterval: (query: { state: { data?: unknown } }) =>
        analysisStatusOf(query.state.data as PickWithAnalysis | undefined) === "pending" ? ANALYSIS_POLL_MS : false,
      refetchOnWindowFocus: false,
    })),
  });

  const live: PickWithAnalysis[] = picks.map((p, i) => {
    const r = results[i];
    const d = r?.data as PickWithAnalysis | undefined;
    // Only trust the polled copy when it's newer than the session payload we're rendering from.
    if (!d || d.id !== p.id || r.dataUpdatedAt <= sessionUpdatedAt) return p;
    return { ...p, analysisStatus: d.analysisStatus, analysisError: d.analysisError, items: d.items ?? p.items, palette: d.palette ?? p.palette };
  });

  // Fire onSettled exactly once per (pick, poll result) transition from pending → ready/failed.
  const notified = useRef(new Set<string>());
  const settledKeys = picks
    .map((p, i) => {
      const r = results[i];
      const d = r?.data as PickWithAnalysis | undefined;
      if (!d || analysisStatusOf(p) !== "pending" || analysisStatusOf(d) === "pending" || r.dataUpdatedAt <= sessionUpdatedAt) return null;
      return `${p.id}:${r.dataUpdatedAt}`;
    })
    .filter((k): k is string => !!k);
  const settledSig = settledKeys.join("|");
  useEffect(() => {
    if (!settledSig) return;
    settledKeys.forEach((k) => {
      if (notified.current.has(k)) return;
      notified.current.add(k);
      const id = Number(k.split(":")[0]);
      const pick = live.find((p) => p.id === id);
      if (pick) onSettled(pick);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledSig]);

  return live;
}

/** POST /api/picks/:id/analyze (owner only) — flips the pick back to pending so polling resumes. */
function useRetryAnalysis(queryKey: unknown[], onDone: () => void) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: (pickId: number) => apiJson<PickWithAnalysis>("POST", `/api/picks/${pickId}/analyze`),
    onMutate: (pickId) => {
      // Optimistically mark pending in the session so the shimmer shows and the poller enables immediately.
      const mark = (old: SessionView | undefined) =>
        old ? { ...old, picks: old.picks.map((p) => (p.id === pickId ? ({ ...p, analysisStatus: "pending", analysisError: null } as PickWithAnalysis) : p)) } : old;
      queryClient.setQueryData<SessionView>(queryKey, mark);
      queryClient.removeQueries({ queryKey: ["/api/picks", pickId], exact: true });
    },
    onSuccess: () => onDone(),
    onError: (e: Error) => toast({ title: e.message || "Couldn't retry right now", variant: "destructive" }),
  });
}

/** The heart of the app: one day's picks for one crew. Used by the crew page (day strip) and deep links. */
export function SessionBody({ session: s, queryKey }: { session: SessionView; queryKey: unknown[] }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [openPick, setOpenPick] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  // Optimistic "Post my pick" slot: local preview + upload progress until the 201 lands.
  const [local, setLocal] = useState<{ previewUrl: string; progress: number; phase: "preparing" | "uploading" } | null>(null);
  // After the 201, keep the local preview under the real photo until the server copy has loaded.
  const [recentPreview, setRecentPreview] = useState<{ pickId: number; url: string } | null>(null);
  const userId = user?.id;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ["/api/sessions", s.id] });
    queryClient.invalidateQueries({ queryKey: ["/api/crews"] });
  };

  const sessionUpdatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
  const picks = useLivePicks(s.picks, sessionUpdatedAt, (pick) => {
    invalidate();
    if (pick.userId === userId) {
      queryClient.invalidateQueries({ queryKey: ["/api/closet"] });
      if (analysisStatusOf(pick) === "ready") {
        toast({
          title: pick.items.length ? `Found ${pick.items.length} ${pick.items.length === 1 ? "piece" : "pieces"} to shop` : "Pick posted",
          description: pick.items.length ? "Tap your pick to see where to buy each one." : "We couldn't make out the pieces; a clearer, well-lit photo works best.",
        });
      }
    }
  });
  const retry = useRetryAnalysis(queryKey, invalidate);

  const post = useMutation({
    mutationFn: async ({ prepared, note }: PostInput) => {
      const file = await prepared;
      setLocal((l) => (l ? { ...l, phase: "uploading" } : l));
      const fd = new FormData();
      fd.append("photo", file);
      if (note) fd.append("note", note);
      return apiUpload<PickWithAnalysis>(`/api/sessions/${s.id}/picks`, fd, (f) => setLocal((l) => (l ? { ...l, progress: f } : l)));
    },
    onSuccess: (p, vars) => {
      // Drop the new pick straight into the cached session so the slot never flashes back to "Post my pick".
      const place = (old: SessionView | undefined) => (old ? { ...old, picks: [...old.picks.filter((x) => x.userId !== p.userId), p] } : old);
      queryClient.setQueryData<SessionView>(queryKey, place);
      setRecentPreview({ pickId: p.id, url: vars.previewUrl });
      setLocal(null);
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["/api/closet"] });
      if (analysisStatusOf(p) === "ready") {
        // Legacy synchronous server: analysis already done.
        toast({ title: "Pick posted", description: p.items.length ? `Found ${p.items.length} pieces to shop.` : "Your crew can see it. We couldn't make out the pieces; a clearer, well-lit photo works best." });
      }
    },
    onError: (e: Error, vars) => {
      setLocal(null);
      URL.revokeObjectURL(vars.previewUrl);
      // 400 from the picks route means the bytes weren't a photo we can decode (e.g. an odd HEIF container).
      // Size limits come back with their own message, so only translate the format case.
      const friendly = errorStatus(e) === 400 && !/large|size|limit/i.test(e.message);
      toast({ title: friendly ? UNSUPPORTED_PHOTO_MESSAGE : e.message, description: "Your pick wasn't posted. Try again.", variant: "destructive" });
    },
  });

  if (!user) return null;

  const myPick = picks.find((p) => p.userId === user.id);
  const pendingCount = picks.filter((p) => analysisStatusOf(p) === "pending").length;
  const match = pendingCount > 0
    ? { score: 0, level: "waiting" as const, label: "Reading outfits…", detail: pendingCount === 1 ? "Pulling the colors from a new pick. The score lands in a moment." : "Pulling the colors from new picks. The score lands in a moment." }
    : picks.length >= 2 && picks.filter((p) => p.palette.length).length < 2
      ? { score: 0, level: "waiting" as const, label: "Colors not read", detail: "Repost a clearer, well-lit photo so we can compare looks." }
      : matchScore(picks.map((p) => p.palette));
  const lockedCount = picks.filter((p) => p.locked).length;
  const selected = picks.find((p) => p.id === openPick) ?? null;

  function startPost(input: PostInput) {
    setUploading(false);
    setLocal({ previewUrl: input.previewUrl, progress: 0, phase: "preparing" });
    post.mutate(input);
  }

  return (
    <>
      <VibeLine session={s} onSaved={invalidate} />
      <MatchMeter level={match.level} label={match.label} detail={match.detail} picked={picks.length + (local && !myPick ? 1 : 0)} total={s.members.length} locked={lockedCount} pending={pendingCount > 0} />

      <div className="mt-4 grid grid-cols-2 gap-3">
        {s.members.map((m) => {
          const p = picks.find((x) => x.userId === m.id);
          const mine = m.id === user.id;
          if (mine && local) return <UploadingCard key={m.id} user={m} previewUrl={local.previewUrl} progress={local.progress} phase={local.phase} />;
          if (!p) return <EmptyPick key={m.id} user={m} mine={mine} onAdd={() => setUploading(true)} />;
          return (
            <PickCard
              key={m.id}
              pick={p}
              mine={mine}
              onOpen={() => setOpenPick(p.id)}
              localPreview={recentPreview?.pickId === p.id ? recentPreview.url : undefined}
              onPhotoLoaded={() => {
                // Let the server photo finish its fade before pulling the local preview from underneath.
                const rp = recentPreview;
                if (rp?.pickId === p.id) window.setTimeout(() => { URL.revokeObjectURL(rp.url); setRecentPreview((cur) => (cur?.pickId === rp.pickId ? null : cur)); }, 400);
              }}
              onRetry={mine ? () => retry.mutate(p.id) : undefined}
              retrying={retry.isPending && retry.variables === p.id}
            />
          );
        })}
      </div>
      {s.members.length === 1 && (
        <p className="mt-3 text-center text-xs text-muted-foreground">It's just you so far. Share the crew code so your friends show up here.</p>
      )}

      {myPick && (
        <div className="mt-5 flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => setUploading(true)} disabled={!!local} data-testid="button-change-pick">
            <Camera className="h-4 w-4" /> Change my pick
          </Button>
          <LockButton pick={myPick} onDone={invalidate} />
        </div>
      )}

      <UploadDialog open={uploading} onClose={() => setUploading(false)} hasExisting={!!myPick} onPost={startPost} />
      <PickDrawer pick={selected} onClose={() => setOpenPick(null)} me={user} onDone={invalidate} onRetry={(id) => retry.mutate(id)} retrying={retry.isPending} />
    </>
  );
}

function VibeLine({ session: s, onSaved }: { session: SessionView; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [vibe, setVibe] = useState(s.vibe ?? "");
  const m = useMutation({
    mutationFn: () => apiJson<SessionView>("PATCH", `/api/sessions/${s.id}`, { vibe: vibe || null }),
    onSuccess: () => { onSaved(); setEditing(false); },
  });
  if (editing) {
    return (
      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Input autoFocus value={vibe} onChange={(e) => setVibe(e.target.value)} placeholder="Vibe: all black, neon, pink & grey…" maxLength={60} data-testid="input-vibe" />
        <Button type="submit" size="sm" disabled={m.isPending} data-testid="button-save-vibe">Save</Button>
      </form>
    );
  }
  return (
    <button type="button" onClick={() => { setVibe(s.vibe ?? ""); setEditing(true); }} className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-sm hover-elevate" data-testid="button-edit-vibe">
      <Sparkles className="h-3.5 w-3.5 text-primary" />
      {s.vibe ? <span><span className="text-muted-foreground">Vibe:</span> {s.vibe}</span> : <span className="text-muted-foreground">Set a vibe for the day</span>}
    </button>
  );
}

// ---------- match meter ----------
const LEVEL_STYLE: Record<MatchLevel, string> = {
  matching: "bg-accent text-accent-foreground",
  coordinated: "bg-accent/70 text-accent-foreground",
  mixed: "bg-secondary text-secondary-foreground",
  clashing: "bg-destructive/10 text-destructive",
  waiting: "bg-secondary text-muted-foreground",
};

function MatchMeter({ level, label, detail, picked, total, locked, pending = false }: { level: MatchLevel; label: string; detail: string; picked: number; total: number; locked: number; pending?: boolean }) {
  const pct = total ? Math.round((picked / total) * 100) : 0;
  return (
    <section className="rounded-2xl border border-card-border bg-card p-4" data-testid="card-match-meter" data-pending={pending ? "true" : undefined}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Match meter</p>
          <p className="font-display text-xl font-bold" data-testid="text-match-label">
            {pending && <Sparkles className="mr-1.5 inline h-4 w-4 animate-pulse text-primary" aria-hidden />}
            {label}
          </p>
          <p className="text-sm text-muted-foreground">{detail}</p>
        </div>
        <span className={cn("shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold", LEVEL_STYLE[level])}>
          {picked}/{total} picked
        </span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{locked} locked in · picks refresh automatically</p>
    </section>
  );
}

// ---------- cards ----------
function EmptyPick({ user, mine, onAdd }: { user: PublicUser; mine: boolean; onAdd: () => void }) {
  return (
    <button
      type="button"
      onClick={mine ? onAdd : undefined}
      className={cn(
        "flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed p-4 text-center",
        mine ? "border-primary/60 bg-primary/5 hover-elevate" : "border-border bg-card/50",
      )}
      data-testid={mine ? "button-add-pick" : `card-waiting-${user.id}`}
    >
      <Avatar user={user} />
      {mine ? (
        <>
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground"><Camera className="h-4 w-4" /></span>
          <span className="text-sm font-semibold">Post my pick</span>
          <span className="text-xs text-muted-foreground">Snap the fit, laid out or on</span>
        </>
      ) : (
        <>
          <span className="text-sm font-semibold">{user.name}</span>
          <span className="text-xs text-muted-foreground">Hasn't picked yet</span>
        </>
      )}
    </button>
  );
}

/** Shimmering stand-ins for the swatches + "N pieces" row while analysis runs. */
function AnalysisPendingRow({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2" data-testid="status-analysis-pending" aria-busy="true" aria-live="polite">
      <span className="inline-flex shrink-0 -space-x-1.5" aria-hidden>
        {[0, 1, 2].map((i) => <span key={i} className={cn("shimmer rounded-full ring-2 ring-card", compact ? "h-3.5 w-3.5" : "h-5 w-5")} style={{ animationDelay: `${i * 120}ms` }} />)}
      </span>
      <span className="truncate text-xs text-muted-foreground">Reading the outfit…</span>
    </div>
  );
}

/** The "Post my pick" slot while the photo is still leaving the phone: local preview + thin progress bar. */
function UploadingCard({ user, previewUrl, progress, phase }: { user: PublicUser; previewUrl: string; progress: number; phase: "preparing" | "uploading" }) {
  const pct = Math.round(progress * 100);
  const indeterminate = phase === "preparing" || progress <= 0;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-card-border bg-card text-left" data-testid="card-uploading" aria-busy="true">
      <div className="aspect-[3/4] w-full bg-muted">
        <img src={previewUrl} alt="Your pick, uploading" className="h-full w-full object-cover" />
      </div>
      <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-background/90 py-1 pl-1 pr-2.5 text-xs font-semibold backdrop-blur">
        <Avatar user={user} size="sm" /> You
      </div>
      <div className="px-2.5 py-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-medium text-foreground">{phase === "preparing" ? "Preparing…" : "Uploading…"}</span>
          {!indeterminate && <span className="tabular-nums text-muted-foreground">{pct}%</span>}
        </div>
        <div
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : pct}
          data-testid="progress-upload"
          data-phase={phase}
        >
          {indeterminate ? (
            <div className="upload-indeterminate h-full w-1/3 rounded-full bg-primary" />
          ) : (
            <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${pct}%` }} />
          )}
        </div>
      </div>
    </div>
  );
}

function PickCard({ pick, mine, onOpen, localPreview, onPhotoLoaded, onRetry, retrying = false }: {
  pick: PickWithAnalysis;
  mine: boolean;
  onOpen: () => void;
  /** Object URL of the just-posted local file; shown under the server photo until it loads. */
  localPreview?: string;
  onPhotoLoaded?: () => void;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const rx = pick.reactions.filter((r) => r.emoji);
  const status = analysisStatusOf(pick);
  const [serverLoaded, setServerLoaded] = useState(false);
  return (
    <div className="relative flex flex-col" data-analysis-status={status}>
      <button type="button" onClick={onOpen} className="relative flex w-full flex-1 flex-col overflow-hidden rounded-2xl border border-card-border bg-card text-left hover-elevate" data-testid={`card-pick-${pick.id}`}>
        <div className="relative aspect-[3/4] w-full bg-muted">
          {/* Local preview stays underneath until the parent clears it (after the server copy has faded in). */}
          {localPreview && <img src={localPreview} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" />}
          <img
            src={assetUrl(pick.photoPath)}
            alt={`${pick.user.name}'s pick`}
            className={cn("relative h-full w-full object-cover transition-opacity duration-300", localPreview && !serverLoaded ? "opacity-0" : "opacity-100")}
            loading={localPreview ? "eager" : "lazy"}
            onLoad={() => { setServerLoaded(true); onPhotoLoaded?.(); }}
            onError={() => { setServerLoaded(true); onPhotoLoaded?.(); }}
          />
        </div>
        <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-background/90 py-1 pl-1 pr-2.5 text-xs font-semibold backdrop-blur">
          <Avatar user={pick.user} size="sm" /> {mine ? "You" : pick.user.name}
        </div>
        {pick.locked && (
          <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-accent text-accent-foreground" title="Locked in"><Lock className="h-3.5 w-3.5" /></span>
        )}
        <div className="mt-auto flex min-h-[2.25rem] w-full items-center justify-between gap-2 px-2.5 py-2">
          {status === "pending" ? (
            <AnalysisPendingRow compact />
          ) : status === "failed" ? (
            // "fit" rather than "outfit": the 2-up card is ~153px wide and the longer copy + Retry won't fit on one line at 390px.
            <span className="min-w-0 truncate text-[11px] text-muted-foreground" data-testid="status-analysis-failed" title={pick.analysisError ?? undefined}>
              Couldn't read this fit{mine && onRetry ? <span className="invisible" aria-hidden> · Retry</span> : null}
            </span>
          ) : (
            <>
              <Swatches colors={pick.palette} size="sm" />
              <span className="text-xs text-muted-foreground">{rx.length > 0 ? rx.map((r) => r.emoji).slice(0, 3).join("") : pick.items.length ? `${pick.items.length} pieces` : ""}</span>
            </>
          )}
        </div>
      </button>
      {status === "failed" && mine && onRetry && (
        // Sibling of the card button (not nested) so it stays valid HTML; the wrapper positions it over the
        // right end of the footer row (.hover-elevate forces position:relative, hence the extra span).
        <span className="absolute bottom-0 right-0 flex h-9 items-center pr-1.5">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRetry(); }}
            disabled={retrying}
            className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-semibold text-primary hover-elevate disabled:opacity-60"
            data-testid="button-retry-analysis"
            aria-label="Retry reading this outfit"
          >
            {retrying ? <RefreshCw className="h-3 w-3 animate-spin" aria-hidden /> : <span aria-hidden>·</span>} Retry
          </button>
        </span>
      )}
    </div>
  );
}

function LockButton({ pick, onDone }: { pick: PickView; onDone: () => void }) {
  const m = useMutation({
    mutationFn: () => apiJson<PickView>("PATCH", `/api/picks/${pick.id}`, { locked: !pick.locked }),
    onSuccess: onDone,
  });
  return (
    <Button className="flex-1" variant={pick.locked ? "secondary" : "default"} onClick={() => m.mutate()} disabled={m.isPending} data-testid="button-lock">
      {pick.locked ? <><Unlock className="h-4 w-4" /> Unlock</> : <><Lock className="h-4 w-4" /> Lock it in</>}
    </Button>
  );
}

// ---------- upload ----------
interface PostInput {
  /** Downscaled (or original, if the browser can't decode it) file; started the moment the photo was chosen. */
  prepared: Promise<File>;
  previewUrl: string;
  note: string;
}

/**
 * Pick a photo + optional note. Posting closes the dialog immediately and hands the work to the
 * session body, which shows the local preview with an upload bar in the "Post my pick" slot — no
 * modal spinner, and the user is free to navigate away. Downscaling starts as soon as the file is
 * chosen so it's usually done by the time they tap Post.
 */
function UploadDialog({ open, onClose, hasExisting, onPost }: { open: boolean; onClose: () => void; hasExisting: boolean; onPost: (input: PostInput) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Promise<File> | null>(null);
  const [note, setNote] = useState("");

  function reset(revoke = true) {
    if (revoke && preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview(null);
    setPrepared(null);
    setNote("");
  }
  // HEIC/HEIF or an empty type still goes through: iOS usually hands web inputs a JPEG, and when it
  // doesn't, downscaleForUpload returns the original and the server sniffs the bytes and tells us.
  function onFile(f: File | undefined) {
    if (!f) return;
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(URL.createObjectURL(f));
    const p = downscaleForUpload(f).then((r) => r.file).catch((err) => { console.debug("[image] downscale threw, sending original", err); return f; });
    setPrepared(p);
  }
  function submit() {
    if (!file || !preview) return;
    onPost({ prepared: prepared ?? Promise.resolve(file), previewUrl: preview, note });
    reset(false); // the session body owns the object URL now
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader><DialogTitle className="font-display text-xl">{hasExisting ? "Change my pick" : "Post my pick"}</DialogTitle></DialogHeader>
        <PhotoSourcePicker onFile={onFile} testIdPrefix="photo">
          <button
            type="button"
            className="relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-2xl border border-dashed border-border bg-muted"
            data-testid="button-choose-photo"
          >
            {preview ? (
              <>
                <img src={preview} alt="Outfit preview" className="h-full w-full object-cover" />
                <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/90 px-3 py-1 text-xs font-medium backdrop-blur" data-testid="text-replace-photo">
                  Tap to replace photo
                </span>
              </>
            ) : (
              <div className="text-center text-sm text-muted-foreground">
                <Camera className="mx-auto mb-2 h-7 w-7" />
                Tap to take or choose a photo
              </div>
            )}
          </button>
        </PhotoSourcePicker>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional): 'wearing the new set'" maxLength={200} data-testid="input-note" />
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> Your crew sees the photo right away; we'll pull out the colors and each piece, then link where to shop it.</p>
        {hasExisting && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground" data-testid="text-replace-warning">Replacing your pick clears your crew's reactions and unlocks it.</p>}
        <Button onClick={submit} disabled={!file} className="w-full" size="lg" data-testid="button-post-pick">
          Post to crew
        </Button>
      </DialogContent>
    </Dialog>
  );
}

// ---------- live prices (GET /api/picks/:id/prices) ----------
// Offer shape + highlight rule live in @/lib/offers (pure, unit-testable).
interface PricedItem extends GarmentItem {
  offers: PriceOffer[];
}
interface PricesResponse {
  items: PricedItem[];
}

const PRICES_STALE_MS = 10 * 60 * 1000;

/** Fetches live offers once per pick; failures (route missing, provider down) degrade to "no offers" rather than an error state. */
function usePickPrices(pick: PickWithAnalysis | null) {
  return useQuery<PricesResponse>({
    queryKey: ["/api/picks", pick?.id, "prices"],
    // Never hit /prices while the garments are still being read: items is [] until analysis is ready.
    enabled: !!pick && analysisStatusOf(pick) === "ready" && pick.items.length > 0,
    staleTime: PRICES_STALE_MS,
    gcTime: PRICES_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
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
function ShopCard({ item, index, pickId, loading }: { item: PricedItem; index: number; pickId: number; loading: boolean }) {
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

/** Shop-card stand-ins shown in the drawer while analysis is pending. */
function ShopCardsShimmer() {
  return (
    <div data-testid="status-analysis-pending" aria-busy="true" aria-live="polite">
      <p className="mb-2 flex items-center gap-1.5 text-sm text-muted-foreground"><Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" aria-hidden /> Reading the outfit…</p>
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

// ---------- detail drawer ----------
function PickDrawer({ pick, onClose, me, onDone, onRetry, retrying = false }: { pick: PickWithAnalysis | null; onClose: () => void; me: PublicUser; onDone: () => void; onRetry?: (pickId: number) => void; retrying?: boolean }) {
  const [comment, setComment] = useState("");
  const status = pick ? analysisStatusOf(pick) : "ready";
  const { toast } = useToast();
  const invalidate = onDone;

  const react = useMutation({
    mutationFn: (body: { emoji?: string; comment?: string }) => apiJson<PickView>("POST", `/api/picks/${pick!.id}/reactions`, body),
    onSuccess: () => { invalidate(); setComment(""); },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: () => apiJson("DELETE", `/api/picks/${pick!.id}`),
    onSuccess: () => { invalidate(); queryClient.invalidateQueries({ queryKey: ["/api/closet"] }); onClose(); },
  });

  const [confirmRemove, setConfirmRemove] = useState(false);
  const prices = usePickPrices(pick);
  // Align priced items to the pick's garments by index; anything missing (route not deployed yet, provider down) falls back to no offers.
  const pricedItems: PricedItem[] = (pick?.items ?? []).map((it, i) => {
    const p = prices.data?.items?.[i];
    return { ...it, links: Array.isArray(p?.links) && p.links.length ? p.links : it.links, offers: Array.isArray(p?.offers) ? p.offers : [] };
  });
  const pricesLoading = prices.isLoading;
  const mine = pick?.userId === me.id;
  const comments = pick?.reactions.filter((r) => r.comment) ?? [];
  const emojiCounts = EMOJIS.map((e) => ({ e, n: pick?.reactions.filter((r) => r.emoji === e).length ?? 0, me: pick?.reactions.some((r) => r.emoji === e && r.userId === me.id) }));

  return (
    <Drawer open={!!pick} onOpenChange={(o) => { if (!o) { setConfirmRemove(false); onClose(); } }}>
      <DrawerContent className="mx-auto max-h-[92dvh] max-w-md">
        {pick && (
          <div className="overflow-y-auto px-4 pb-8">
            <DrawerHeader className="px-0 text-left">
              <DrawerTitle className="flex items-center gap-2 font-display text-xl">
                <Avatar user={pick.user} size="sm" /> {mine ? "Your pick" : `${pick.user.name}'s pick`}
                {pick.locked && <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground"><Lock className="h-3 w-3" /> Locked</span>}
              </DrawerTitle>
            </DrawerHeader>
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3">
              <img src={assetUrl(pick.photoPath)} alt="" className="aspect-[3/4] w-full rounded-2xl object-cover" />
              <div className="min-w-0">
                {pick.note && <p className="mb-2 text-sm">{pick.note}</p>}
                {status === "pending" ? (
                  <span className="inline-flex -space-x-1.5" aria-hidden>
                    {[0, 1, 2].map((i) => <span key={i} className="shimmer h-5 w-5 rounded-full ring-2 ring-card" style={{ animationDelay: `${i * 120}ms` }} />)}
                  </span>
                ) : (
                  <Swatches colors={pick.palette} />
                )}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {emojiCounts.map(({ e, n, me: on }) => (
                    <button key={e} onClick={() => react.mutate({ emoji: e })} className={cn("rounded-full border px-2.5 py-1 text-sm hover-elevate", on ? "border-primary bg-primary/10" : "border-border bg-card")} data-testid={`button-react-${e}`}>
                      {e}{n > 0 && <span className="ml-1 text-xs text-muted-foreground">{n}</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <h3 className="mb-2 mt-5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><Tag className="h-3.5 w-3.5" /> Shop the pieces</h3>
            {status === "pending" ? (
              <ShopCardsShimmer />
            ) : status === "failed" ? (
              <div className="rounded-xl bg-muted p-3 text-sm text-muted-foreground" data-testid="status-analysis-failed">
                <p>Couldn't read this outfit{pick.analysisError ? <span className="text-xs"> — {pick.analysisError}</span> : null}. Your crew can still see the photo.</p>
                {mine && onRetry && (
                  <button type="button" onClick={() => onRetry(pick.id)} disabled={retrying} className="mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold text-primary hover-elevate disabled:opacity-60" data-testid="button-retry-analysis">
                    <RefreshCw className={cn("h-3 w-3", retrying && "animate-spin")} aria-hidden /> Retry
                  </button>
                )}
              </div>
            ) : pick.items.length === 0 ? (
              <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">We couldn't read the pieces in this photo. A clearer, well-lit shot works best.</p>
            ) : (
              <>
                <ul className="space-y-2" data-testid="list-shop-items">
                  {pricedItems.map((it, i) => (
                    <ShopCard key={`${pick.id}-${i}`} item={it} index={i} pickId={pick.id} loading={pricesLoading} />
                  ))}
                </ul>
                <p className="mt-2 text-[11px] leading-snug text-muted-foreground" data-testid="text-affiliate-disclosure">
                  Affiliate links may earn MMV a commission at no extra cost to you. As an Amazon Associate, MMV earns from qualifying purchases.
                </p>
              </>
            )}

            <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Crew notes</h3>
            <div className="space-y-2">
              {comments.length === 0 && <p className="text-sm text-muted-foreground">No notes yet.</p>}
              {comments.map((c) => (
                <div key={c.id} className="flex items-start gap-2 text-sm" data-testid={`text-comment-${c.id}`}>
                  <Avatar user={c.user} size="sm" />
                  <p><span className="font-semibold">{c.user.name}</span> {c.comment}</p>
                </div>
              ))}
            </div>
            <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) react.mutate({ comment: comment.trim() }); }}>
              <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Very you. Swap the shoes?" maxLength={200} data-testid="input-comment" />
              <Button type="submit" size="icon" disabled={!comment.trim() || react.isPending} aria-label="Send" data-testid="button-send-comment"><Send className="h-4 w-4" /></Button>
            </form>

            {mine && !confirmRemove && (
              <Button variant="ghost" className="mt-4 w-full text-destructive" onClick={() => setConfirmRemove(true)} data-testid="button-delete-pick">
                <Trash2 className="h-4 w-4" /> Remove my pick
              </Button>
            )}
            {mine && confirmRemove && (
              <div className="mt-4 flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setConfirmRemove(false)} data-testid="button-cancel-delete">Keep it</Button>
                <Button variant="destructive" className="flex-1" onClick={() => remove.mutate()} disabled={remove.isPending} data-testid="button-confirm-delete">Yes, remove</Button>
              </div>
            )}
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}
