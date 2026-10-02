import { useEffect, useRef, useState } from "react";
import { useQuery, useQueries, useMutation } from "@tanstack/react-query";
import { Camera, Lock, Unlock, Sparkles, Trash2, Send, Tag, RefreshCw, Images, Plus, X, ImagePlus } from "lucide-react";
import type { SessionView, PickView, PublicUser } from "@shared/schema";
import { Page, Avatar, Swatches } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiJson, apiUpload, assetUrl, errorStatus, queryClient } from "@/lib/queryClient";
import { PhotoSourcePicker, UNSUPPORTED_PHOTO_MESSAGE } from "@/components/photo-picker";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { formatDate, matchScore, type MatchLevel } from "@/lib/color";
import { cn } from "@/lib/utils";
import { AffiliateDisclosure, ShopCard, ShopCardsShimmer, mergePricedItems, usePrices } from "@/components/shop-cards";
import { ShareToDiscover } from "@/components/share-discover";
import { downscaleForUpload } from "@/lib/image";
import { ANALYSIS_POLL_MS, MAX_PICK_PHOTOS, analysisStatusOf, coverUrlOf, photosOf, type PickPhotoView, type PickWithAnalysis } from "@/lib/analysis";

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
function useLivePicks(picks: PickWithAnalysis[], sessionUpdatedAt: number, onSettled: (pick: PickWithAnalysis) => void): PickWithAnalysis[] {
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
    // `photos` rides along in the same payload, so per-photo statuses refresh with the pick-level one.
    // Optimistic slides (an "Add photos" upload still in flight) aren't known to the server yet — keep them
    // on top of the polled copy and stay pending until the 201 replaces them, or a poll would blink them away.
    const optimistic = (p.photos ?? []).filter((ph) => ph.optimistic);
    const photos = d.photos ? [...d.photos, ...optimistic] : p.photos;
    const analysisStatus = optimistic.length ? "pending" : d.analysisStatus;
    return { ...p, analysisStatus, analysisError: d.analysisError, items: d.items ?? p.items, palette: d.palette ?? p.palette, photos };
  });

  // Fire onSettled exactly once per (pick, poll result) transition from pending → ready/failed.
  const notified = useRef(new Set<string>());
  const settledKeys = picks
    .map((p, i) => {
      const r = results[i];
      const d = r?.data as PickWithAnalysis | undefined;
      if (!d || analysisStatusOf(p) !== "pending" || analysisStatusOf(d) === "pending" || r.dataUpdatedAt <= sessionUpdatedAt) return null;
      if ((p.photos ?? []).some((ph) => ph.optimistic)) return null; // still uploading new photos; not settled yet
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

/** The cached session, with picks typed loosely so optimistic/legacy copies (no `photos`, no status) fit. */
type SessionCache = Omit<SessionView, "picks"> & { picks: PickWithAnalysis[] };

/** Rewrite one pick inside the cached session (no-op when the session or pick isn't cached). */
function patchPickInSession(queryKey: unknown[], pickId: number, fn: (p: PickWithAnalysis) => PickWithAnalysis) {
  queryClient.setQueryData<SessionCache>(queryKey, (old) => (old ? { ...old, picks: old.picks.map((p) => (p.id === pickId ? fn(p) : p)) } : old));
}

/** Replace one pick inside the cached session with the server's copy (keeps the slot from flashing). */
function placePickInSession(queryKey: unknown[], pick: PickWithAnalysis) {
  queryClient.setQueryData<SessionCache>(queryKey, (old) => (old ? { ...old, picks: old.picks.map((p) => (p.id === pick.id ? pick : p)) } : old));
}

/**
 * Mark a pick pending in the session cache and drop its stale poll result so `useLivePicks`
 * re-enables the poller immediately (the removed query refetches on enable).
 */
function markPickPending(queryKey: unknown[], pickId: number, photoId?: number) {
  patchPickInSession(queryKey, pickId, (p) => ({
    ...p,
    analysisStatus: "pending",
    analysisError: null,
    photos: photoId === undefined ? p.photos : p.photos?.map((ph) => (ph.id === photoId ? { ...ph, analysisStatus: "pending", analysisError: null } : ph)),
  }));
  queryClient.removeQueries({ queryKey: ["/api/picks", pickId], exact: true });
}

/** POST /api/picks/:id/analyze (owner only) — flips the pick back to pending so polling resumes. */
function useRetryAnalysis(queryKey: unknown[], onDone: () => void) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: (pickId: number) => apiJson<PickWithAnalysis>("POST", `/api/picks/${pickId}/analyze`),
    // Optimistically mark pending in the session so the shimmer shows and the poller enables immediately.
    onMutate: (pickId) => markPickPending(queryKey, pickId),
    onSuccess: () => onDone(),
    onError: (e: Error) => toast({ title: e.message || "Couldn't retry right now", variant: "destructive" }),
  });
}

/** POST /api/picks/:id/photos/:photoId/analyze (owner only) — re-queues a single photo. */
function useRetryPhoto(queryKey: unknown[], onDone: () => void) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ pickId, photoId }: { pickId: number; photoId: number }) => apiJson<PickWithAnalysis>("POST", `/api/picks/${pickId}/photos/${photoId}/analyze`),
    onMutate: ({ pickId, photoId }) => markPickPending(queryKey, pickId, photoId),
    onSuccess: () => onDone(),
    onError: (e: Error) => toast({ title: e.message || "Couldn't retry right now", variant: "destructive" }),
  });
}

/**
 * POST /api/picks/:id/photos (owner only) — appends photos to an existing pick. The new photos show up
 * at once as local previews (status pending); the 201 PickView replaces them and polling resumes.
 */
function useAddPhotos(queryKey: unknown[], onDone: () => void) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async ({ pickId, files }: { pickId: number; files: File[]; previewUrls: string[] }) => {
      const prepared = await Promise.all(files.map((f) => downscaleForUpload(f).then((r) => r.file).catch(() => f)));
      const fd = new FormData();
      prepared.forEach((f) => fd.append("photo", f));
      return apiUpload<PickWithAnalysis>(`/api/picks/${pickId}/photos`, fd);
    },
    onMutate: ({ pickId, previewUrls }) => {
      patchPickInSession(queryKey, pickId, (p) => {
        const existing = photosOf(p); // legacy picks contribute their synthetic photoPath entry
        const start = existing.length;
        const optimistic: PickPhotoView[] = previewUrls.map((url, i) => ({ id: -(Date.now() + i), url, position: start + i, analysisStatus: "pending", analysisError: null, itemCount: 0, optimistic: true }));
        return { ...p, analysisStatus: "pending", analysisError: null, photos: [...existing, ...optimistic] };
      });
    },
    onSuccess: (pick, vars) => {
      vars.previewUrls.forEach((u) => URL.revokeObjectURL(u));
      placePickInSession(queryKey, { ...pick, analysisStatus: pick.analysisStatus ?? "pending" });
      queryClient.removeQueries({ queryKey: ["/api/picks", pick.id], exact: true });
      onDone();
    },
    onError: (e: Error, vars) => {
      vars.previewUrls.forEach((u) => URL.revokeObjectURL(u));
      // Roll the optimistic entries back; a refetch restores the server truth.
      patchPickInSession(queryKey, vars.pickId, (p) => ({ ...p, photos: p.photos?.filter((ph) => !ph.optimistic) }));
      onDone();
      const friendly = errorStatus(e) === 400 && !/large|size|limit|most|max/i.test(e.message);
      toast({ title: friendly ? UNSUPPORTED_PHOTO_MESSAGE : e.message || "Couldn't add those photos", description: "Nothing was added. Try again.", variant: "destructive" });
    },
  });
}

/** DELETE /api/picks/:id/photos/:photoId (owner only). The server refuses to remove the last photo. */
function useRemovePhoto(queryKey: unknown[], onDone: () => void) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ pickId, photoId }: { pickId: number; photoId: number }) => apiJson<PickWithAnalysis>("DELETE", `/api/picks/${pickId}/photos/${photoId}`),
    onMutate: ({ pickId, photoId }) => {
      patchPickInSession(queryKey, pickId, (p) => ({ ...p, photos: p.photos?.filter((ph) => ph.id !== photoId) }));
    },
    onSuccess: (pick) => {
      placePickInSession(queryKey, pick);
      queryClient.removeQueries({ queryKey: ["/api/picks", pick.id], exact: true });
      onDone();
    },
    onError: (e: Error) => {
      onDone(); // refetch restores the photo we removed optimistically
      toast({ title: e.message || "Couldn't remove that photo", variant: "destructive" });
    },
  });
}

/** The heart of the app: one day's picks for one crew. Used by the crew page (day strip) and deep links. */
export function SessionBody({ session: s, queryKey }: { session: SessionView; queryKey: unknown[] }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [openPick, setOpenPick] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  // Optimistic "Post my pick" slot: local preview + upload progress until the 201 lands.
  const [local, setLocal] = useState<{ previewUrl: string; count: number; progress: number; phase: "preparing" | "uploading" } | null>(null);
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
      const files = await prepared;
      setLocal((l) => (l ? { ...l, phase: "uploading" } : l));
      // One multipart request; the `photo` field repeats once per file (1–6).
      const fd = new FormData();
      files.forEach((f) => fd.append("photo", f));
      if (note) fd.append("note", note);
      return apiUpload<PickWithAnalysis>(`/api/sessions/${s.id}/picks`, fd, (f) => setLocal((l) => (l ? { ...l, progress: f } : l)));
    },
    onSuccess: (p, vars) => {
      // Drop the new pick straight into the cached session so the slot never flashes back to "Post my pick".
      const place = (old: SessionCache | undefined) => (old ? { ...old, picks: [...old.picks.filter((x) => x.userId !== p.userId), p] } : old);
      queryClient.setQueryData<SessionCache>(queryKey, place);
      setRecentPreview({ pickId: p.id, url: vars.previewUrls[0] });
      vars.previewUrls.slice(1).forEach((u) => URL.revokeObjectURL(u));
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
      vars.previewUrls.forEach((u) => URL.revokeObjectURL(u));
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
    setLocal({ previewUrl: input.previewUrls[0], count: input.previewUrls.length, progress: 0, phase: "preparing" });
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
          if (mine && local) return <UploadingCard key={m.id} user={m} previewUrl={local.previewUrl} count={local.count} progress={local.progress} phase={local.phase} />;
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
      <PickDrawer pick={selected} onClose={() => setOpenPick(null)} me={user} queryKey={queryKey} onDone={invalidate} onRetry={(id) => retry.mutate(id)} retrying={retry.isPending} activity={s.crew.activity} />
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

/** Small "1/3" pill in the bottom-right corner of a pick photo when the pick has more than one. */
function PhotoCountBadge({ index = 0, total, className }: { index?: number; total: number; className?: string }) {
  if (total <= 1) return null;
  return (
    <span
      className={cn("pointer-events-none absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white backdrop-blur-sm", className)}
      data-testid="badge-photo-count"
      aria-label={`${total} photos`}
    >
      <Images className="h-3 w-3" aria-hidden /> {index + 1}/{total}
    </span>
  );
}

/** The "Post my pick" slot while the photo is still leaving the phone: local preview + thin progress bar. */
function UploadingCard({ user, previewUrl, count = 1, progress, phase }: { user: PublicUser; previewUrl: string; count?: number; progress: number; phase: "preparing" | "uploading" }) {
  const pct = Math.round(progress * 100);
  const indeterminate = phase === "preparing" || progress <= 0;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-card-border bg-card text-left" data-testid="card-uploading" aria-busy="true">
      <div className="relative aspect-[3/4] w-full bg-muted">
        <img src={previewUrl} alt="Your pick, uploading" className="h-full w-full object-cover" />
        <PhotoCountBadge total={count} />
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
  const photoCount = photosOf(pick).length;
  const [serverLoaded, setServerLoaded] = useState(false);
  return (
    <div className="relative flex flex-col" data-analysis-status={status} data-photo-count={photoCount}>
      <button type="button" onClick={onOpen} className="relative flex w-full flex-1 flex-col overflow-hidden rounded-2xl border border-card-border bg-card text-left hover-elevate" data-testid={`card-pick-${pick.id}`}>
        <div className="relative aspect-[3/4] w-full bg-muted">
          {/* Local preview stays underneath until the parent clears it (after the server copy has faded in). */}
          {localPreview && <img src={localPreview} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" />}
          <img
            src={assetUrl(coverUrlOf(pick))}
            alt={`${pick.user.name}'s pick`}
            className={cn("relative h-full w-full object-cover transition-opacity duration-300", localPreview && !serverLoaded ? "opacity-0" : "opacity-100")}
            loading={localPreview ? "eager" : "lazy"}
            onLoad={() => { setServerLoaded(true); onPhotoLoaded?.(); }}
            onError={() => { setServerLoaded(true); onPhotoLoaded?.(); }}
          />
          <PhotoCountBadge total={photoCount} />
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

function LockButton({ pick, onDone }: { pick: PickWithAnalysis; onDone: () => void }) {
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
  /** Downscaled (or original, if the browser can't decode it) files, in strip order; started the moment each photo was chosen. */
  prepared: Promise<File[]>;
  /** Object URLs for the local previews, same order as `prepared`. The first one is the cover. */
  previewUrls: string[];
  note: string;
}

interface StagedPhoto {
  key: string;
  file: File;
  previewUrl: string;
  prepared: Promise<File>;
}

/** Downscale in the background; on any failure ship the original and let the server sniff it. */
function prepareForUpload(f: File): Promise<File> {
  return downscaleForUpload(f).then((r) => r.file).catch((err) => { console.debug("[image] downscale threw, sending original", err); return f; });
}

/**
 * Pick 1–6 photos + optional note. Posting closes the dialog immediately and hands the work to the
 * session body, which shows the local preview with an upload bar in the "Post my pick" slot — no
 * modal spinner, and the user is free to navigate away. Downscaling starts (in parallel) as soon as
 * the files are chosen so it's usually done by the time they tap Post.
 */
function UploadDialog({ open, onClose, hasExisting, onPost }: { open: boolean; onClose: () => void; hasExisting: boolean; onPost: (input: PostInput) => void }) {
  const [photos, setPhotos] = useState<StagedPhoto[]>([]);
  const [note, setNote] = useState("");
  const { toast } = useToast();
  const remaining = MAX_PICK_PHOTOS - photos.length;

  function reset(revoke = true) {
    if (revoke) photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    setPhotos([]);
    setNote("");
  }
  // HEIC/HEIF or an empty type still goes through: iOS usually hands web inputs a JPEG, and when it
  // doesn't, downscaleForUpload returns the original and the server sniffs the bytes and tells us.
  function onFiles(files: File[]) {
    const accepted = files.slice(0, Math.max(0, remaining));
    if (!accepted.length) return;
    if (accepted.length < files.length) toast({ title: `Up to ${MAX_PICK_PHOTOS} photos per pick`, description: `Added the first ${accepted.length}.` });
    const staged = accepted.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, file: f, previewUrl: URL.createObjectURL(f), prepared: prepareForUpload(f) }));
    setPhotos((cur) => [...cur, ...staged]);
  }
  function removeAt(key: string) {
    setPhotos((cur) => {
      const gone = cur.find((p) => p.key === key);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return cur.filter((p) => p.key !== key);
    });
  }
  function submit() {
    if (!photos.length) return;
    onPost({ prepared: Promise.all(photos.map((p) => p.prepared)), previewUrls: photos.map((p) => p.previewUrl), note });
    reset(false); // the session body owns the object URLs now
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader><DialogTitle className="font-display text-xl">{hasExisting ? "Change my pick" : "Post my pick"}</DialogTitle></DialogHeader>
        {photos.length === 0 ? (
          <PhotoSourcePicker onFiles={onFiles} max={MAX_PICK_PHOTOS} testIdPrefix="photo">
            <button
              type="button"
              className="relative flex aspect-[3/4] max-h-[44dvh] w-full flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed border-border bg-muted"
              data-testid="button-choose-photo"
            >
              <div className="text-center text-sm text-muted-foreground">
                <Camera className="mx-auto mb-2 h-7 w-7" />
                Tap to take or choose photos
                <span className="mt-1 block text-xs">Up to {MAX_PICK_PHOTOS} · a full-outfit shot, single pieces, or both</span>
              </div>
            </button>
          </PhotoSourcePicker>
        ) : (
          // min-w-0: the dialog is a grid; without it the strip's content width would stretch the dialog past the viewport.
          <div className="min-w-0">
            <div className="-mx-6 flex snap-x gap-2 overflow-x-auto px-6 pb-1 no-scrollbar" data-testid="strip-upload-photos" aria-label={`${photos.length} of ${MAX_PICK_PHOTOS} photos`}>
              {photos.map((p, i) => (
                <div key={p.key} className="relative aspect-[3/4] w-24 shrink-0 snap-start overflow-hidden rounded-xl bg-muted" data-testid={`thumb-upload-${i}`}>
                  {/* The first thumb keeps the legacy alt so older QA flows still find "the preview". */}
                  <img src={p.previewUrl} alt={i === 0 ? "Outfit preview" : `Outfit photo ${i + 1}`} className="h-full w-full object-cover" />
                  {i === 0 && photos.length > 1 && <span className="absolute bottom-1 left-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">Cover</span>}
                  {/* .hover-elevate forces position:relative, so the absolute offset lives on a wrapper span. */}
                  <span className="absolute right-1 top-1">
                    <button
                      type="button"
                      onClick={() => removeAt(p.key)}
                      className="flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm hover-elevate"
                      aria-label={`Remove photo ${i + 1}`}
                      data-testid={`button-remove-upload-${i}`}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </span>
                </div>
              ))}
              {remaining > 0 && (
                <PhotoSourcePicker onFiles={onFiles} max={remaining} title="Add more" testIdPrefix="photo">
                  {/* Same test id as the empty-state tile: it's the one tappable surface that opens the photo sheet. */}
                  <button
                    type="button"
                    className="flex aspect-[3/4] w-24 shrink-0 snap-start flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-primary/60 bg-primary/5 text-primary hover-elevate"
                    data-testid="button-choose-photo"
                    aria-label="Add more photos"
                  >
                    <Plus className="h-5 w-5" aria-hidden />
                    <span className="text-xs font-semibold">Add more</span>
                    <span className="text-[10px] text-muted-foreground">{photos.length}/{MAX_PICK_PHOTOS}</span>
                  </button>
                </PhotoSourcePicker>
              )}
            </div>
            {/* Keeps the `text-replace-photo` id alive for QA that waits on the post-choice hint. */}
            <p className="mt-1.5 text-xs text-muted-foreground" data-testid="text-replace-photo">
              {remaining > 0 ? "Add a full-outfit shot, single pieces, or both." : `That's the max (${MAX_PICK_PHOTOS}). Tap × on a photo to swap it.`}
            </p>
          </div>
        )}
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional): 'wearing the new set'" maxLength={200} data-testid="input-note" />
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> Your crew sees the photos right away; we'll pull out the colors and each piece, then link where to shop it.</p>
        {hasExisting && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground" data-testid="text-replace-warning">Replacing your pick clears your crew's reactions and unlocks it.</p>}
        <Button onClick={submit} disabled={!photos.length} className="w-full" size="lg" data-testid="button-post-pick">
          {photos.length > 1 ? `Post ${photos.length} photos to crew` : "Post to crew"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

// ---------- live prices (GET /api/picks/:id/prices) ----------
// ShopCard / ShopCardsShimmer / usePrices live in @/components/shop-cards (shared with the Discover sheet).
function usePickPrices(pick: PickWithAnalysis | null) {
  // Never hit /prices while the garments are still being read: items is [] until analysis is ready.
  return usePrices(["/api/picks", pick?.id, "prices"], !!pick && analysisStatusOf(pick) === "ready" && pick.items.length > 0);
}

// ---------- detail drawer ----------
/** Tiny per-photo status pill over a strip slide: shimmer while pending, "Couldn't read · Retry" when failed, nothing when ready. */
function PhotoStatusPill({ photo, canRetry, onRetry, retrying }: { photo: PickPhotoView; canRetry: boolean; onRetry: () => void; retrying: boolean }) {
  const st = analysisStatusOf(photo);
  if (st === "ready") return null;
  if (st === "pending") {
    return (
      <span className="absolute bottom-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-background/90 py-1 pl-1.5 pr-2.5 text-[11px] font-medium text-muted-foreground backdrop-blur" data-testid="status-photo-pending" aria-busy="true" aria-live="polite">
        <span className="inline-flex -space-x-1" aria-hidden>
          {[0, 1, 2].map((i) => <span key={i} className="shimmer h-3 w-3 rounded-full ring-2 ring-background" style={{ animationDelay: `${i * 120}ms` }} />)}
        </span>
        {photo.optimistic ? "Uploading…" : "Reading…"}
      </span>
    );
  }
  return (
    <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-background/90 py-1 pl-2.5 pr-1.5 text-[11px] font-medium text-muted-foreground backdrop-blur" data-testid="status-photo-failed" title={photo.analysisError ?? undefined}>
      Couldn't read
      {canRetry ? (
        <>
          <span aria-hidden>·</span>
          <button type="button" onClick={onRetry} disabled={retrying} className="inline-flex h-6 items-center gap-1 rounded-full px-1.5 font-semibold text-primary hover-elevate disabled:opacity-60" data-testid="button-retry-photo" aria-label="Retry reading this photo">
            {retrying && <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />} Retry
          </button>
        </>
      ) : <span className="pr-1" />}
    </span>
  );
}

/**
 * Full-width, swipeable scroll-snap strip of the pick's photos with a dots indicator. Each slide carries
 * its own status pill (per-photo analysis) and the "n/N" badge; owners get Add / Remove / Retry.
 */
function PickPhotoStrip({ pick, mine, queryKey, onDone, onRetryPick, retryingPick }: { pick: PickWithAnalysis; mine: boolean; queryKey: unknown[]; onDone: () => void; onRetryPick?: (pickId: number) => void; retryingPick: boolean }) {
  const photos = photosOf(pick);
  const n = photos.length;
  const stripRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [confirmPhotoId, setConfirmPhotoId] = useState<number | null>(null);
  // Slide to reveal once the optimistic slides for an "Add photos" exist (set by onAddFiles, consumed below).
  const revealIndex = useRef<number | null>(null);
  const addPhotos = useAddPhotos(queryKey, onDone);
  const removePhoto = useRemovePhoto(queryKey, onDone);
  const retryPhoto = useRetryPhoto(queryKey, onDone);

  // New pick → back to the cover; photos removed → keep the index in range.
  useEffect(() => { setActive(0); setConfirmPhotoId(null); stripRef.current?.scrollTo({ left: 0 }); }, [pick.id]);
  useEffect(() => { if (active > n - 1) setActive(Math.max(0, n - 1)); }, [n, active]);
  useEffect(() => {
    const target = revealIndex.current;
    if (target === null || n <= target) return;
    revealIndex.current = null;
    scrollTo(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);

  function scrollTo(i: number) {
    const el = stripRef.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    setActive(i);
  }
  function onScroll() {
    const el = stripRef.current;
    if (!el || !el.clientWidth) return;
    const i = Math.max(0, Math.min(n - 1, Math.round(el.scrollLeft / el.clientWidth)));
    if (i !== active) setActive(i);
  }
  function onAddFiles(files: File[]) {
    const accepted = files.slice(0, Math.max(0, MAX_PICK_PHOTOS - n));
    if (!accepted.length) return;
    revealIndex.current = n; // first new slide
    addPhotos.mutate({ pickId: pick.id, files: accepted, previewUrls: accepted.map((f) => URL.createObjectURL(f)) });
  }

  const current = photos[Math.min(active, n - 1)];
  const confirming = confirmPhotoId !== null ? photos.find((ph) => ph.id === confirmPhotoId) : undefined;
  const canRemove = n > 1 && !!current && !current.synthetic && !current.optimistic && !removePhoto.isPending;

  return (
    <section aria-label={`${n} ${n === 1 ? "photo" : "photos"}`}>
      <div
        ref={stripRef}
        onScroll={onScroll}
        className="-mx-4 flex snap-x snap-mandatory overflow-x-auto no-scrollbar"
        data-testid="strip-pick-photos"
        data-active={active}
        data-count={n}
      >
        {photos.map((ph, i) => (
          <div key={ph.id} className="w-full shrink-0 snap-center px-4" data-testid={`slide-pick-photo-${i}`} aria-hidden={i !== active}>
            <div className="relative h-[42dvh] max-h-[400px] min-h-[220px] w-full overflow-hidden rounded-2xl bg-muted">
              <img src={assetUrl(ph.url)} alt={`${pick.user.name}'s pick, photo ${i + 1} of ${n}`} className={cn("h-full w-full object-cover", ph.optimistic && "opacity-80")} loading={i === 0 ? "eager" : "lazy"} draggable={false} />
              <PhotoCountBadge index={i} total={n} />
              <PhotoStatusPill
                photo={ph}
                canRetry={mine}
                retrying={ph.synthetic ? retryingPick : retryPhoto.isPending && retryPhoto.variables?.photoId === ph.id}
                onRetry={() => (ph.synthetic ? onRetryPick?.(pick.id) : retryPhoto.mutate({ pickId: pick.id, photoId: ph.id }))}
              />
            </div>
          </div>
        ))}
      </div>

      {(n > 1 || mine) && (
        <div className="mt-2 flex min-h-[1.75rem] items-center justify-between gap-3">
          {n > 1 ? (
            <div className="flex items-center gap-1.5" role="tablist" aria-label="Photos" data-testid="dots-pick-photos">
              {photos.map((ph, i) => (
                <button
                  key={ph.id}
                  type="button"
                  role="tab"
                  aria-selected={i === active}
                  aria-label={`Photo ${i + 1} of ${n}`}
                  onClick={() => scrollTo(i)}
                  className={cn("h-2 rounded-full transition-all", i === active ? "w-5 bg-foreground" : "w-2 bg-muted-foreground/40")}
                  data-testid={`dot-pick-photo-${i}`}
                />
              ))}
            </div>
          ) : <span />}
          {mine && (
            <div className="flex shrink-0 items-center gap-1">
              {n < MAX_PICK_PHOTOS && (
                <PhotoSourcePicker onFiles={onAddFiles} max={MAX_PICK_PHOTOS - n} title="Add photos" side="top" align="end" testIdPrefix="photo-add" disabled={addPhotos.isPending}>
                  <button type="button" disabled={addPhotos.isPending} className="inline-flex h-7 items-center gap-1 rounded-full bg-secondary px-2.5 text-xs font-semibold text-secondary-foreground hover-elevate disabled:opacity-60" data-testid="button-add-photos">
                    <ImagePlus className="h-3.5 w-3.5" aria-hidden /> {addPhotos.isPending ? "Adding…" : "Add photos"}
                  </button>
                </PhotoSourcePicker>
              )}
              <button
                type="button"
                disabled={!canRemove}
                onClick={() => current && setConfirmPhotoId(current.id)}
                title={n <= 1 ? "Use Change my pick instead" : `Remove photo ${active + 1}`}
                className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-semibold text-destructive hover-elevate disabled:opacity-50"
                data-testid="button-remove-photo"
                aria-label={`Remove photo ${active + 1} of ${n}`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
              </button>
            </div>
          )}
        </div>
      )}
      {mine && n <= 1 && (
        <p className="mt-1 text-right text-[11px] text-muted-foreground" data-testid="text-remove-photo-hint">Only photo — use <span className="font-medium text-foreground">Change my pick</span> instead.</p>
      )}
      {mine && confirming && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-muted px-3 py-2 text-xs" data-testid="confirm-remove-photo">
          <span className="min-w-0 truncate">Remove photo {photos.indexOf(confirming) + 1} of {n}?</span>
          <span className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => setConfirmPhotoId(null)} data-testid="button-cancel-remove-photo">Keep</Button>
            <Button size="sm" variant="destructive" className="h-7 px-2.5 text-xs" disabled={removePhoto.isPending} onClick={() => { removePhoto.mutate({ pickId: pick.id, photoId: confirming.id }); setConfirmPhotoId(null); }} data-testid="button-confirm-remove-photo">Remove</Button>
          </span>
        </div>
      )}
    </section>
  );
}

function PickDrawer({ pick, onClose, me, queryKey, onDone, onRetry, retrying = false, activity }: { pick: PickWithAnalysis | null; onClose: () => void; me: PublicUser; queryKey: unknown[]; onDone: () => void; onRetry?: (pickId: number) => void; retrying?: boolean; activity?: string | null }) {
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
  const pricedItems = mergePricedItems(pick?.items ?? [], prices.data);
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

            <PickPhotoStrip pick={pick} mine={!!mine} queryKey={queryKey} onDone={invalidate} onRetryPick={onRetry} retryingPick={retrying} />

            <div className="mt-3 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {pick.note && <p className="mb-2 text-sm">{pick.note}</p>}
                {status === "pending" ? (
                  <span className="inline-flex -space-x-1.5" aria-hidden>
                    {[0, 1, 2].map((i) => <span key={i} className="shimmer h-5 w-5 rounded-full ring-2 ring-card" style={{ animationDelay: `${i * 120}ms` }} />)}
                  </span>
                ) : (
                  <Swatches colors={pick.palette} />
                )}
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                {emojiCounts.map(({ e, n, me: on }) => (
                  <button key={e} onClick={() => react.mutate({ emoji: e })} className={cn("rounded-full border px-2.5 py-1 text-sm hover-elevate", on ? "border-primary bg-primary/10" : "border-border bg-card")} data-testid={`button-react-${e}`}>
                    {e}{n > 0 && <span className="ml-1 text-xs text-muted-foreground">{n}</span>}
                  </button>
                ))}
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
                <AffiliateDisclosure />
              </>
            )}

            {mine && <ShareToDiscover pick={pick} activity={activity} className="mt-5" />}

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
