import { useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Camera, Lock, Unlock, ExternalLink, Sparkles, Trash2, Send, Tag, ChevronDown, ShoppingBag } from "lucide-react";
import type { SessionView, PickView, PublicUser, GarmentItem } from "@shared/schema";
import { Page, Avatar, Swatches } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiJson, apiRequest, assetUrl, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { formatDate, matchScore, type MatchLevel } from "@/lib/color";
import { cn } from "@/lib/utils";

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

/** The heart of the app: one day's picks for one crew. Used by the crew page (day strip) and deep links. */
export function SessionBody({ session: s, queryKey }: { session: SessionView; queryKey: unknown[] }) {
  const { user } = useAuth();
  const [openPick, setOpenPick] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  if (!user) return null;

  const myPick = s.picks.find((p) => p.userId === user.id);
  const match = s.picks.length >= 2 && s.picks.filter((p) => p.palette.length).length < 2
    ? { score: 0, level: "waiting" as const, label: "Colors not read", detail: "Repost a clearer, well-lit photo so we can compare looks." }
    : matchScore(s.picks.map((p) => p.palette));
  const lockedCount = s.picks.filter((p) => p.locked).length;
  const selected = s.picks.find((p) => p.id === openPick) ?? null;
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: ["/api/sessions", s.id] });
    queryClient.invalidateQueries({ queryKey: ["/api/crews"] });
  };

  return (
    <>
      <VibeLine session={s} onSaved={invalidate} />
      <MatchMeter level={match.level} label={match.label} detail={match.detail} picked={s.picks.length} total={s.members.length} locked={lockedCount} />

      <div className="mt-4 grid grid-cols-2 gap-3">
        {s.members.map((m) => {
          const p = s.picks.find((x) => x.userId === m.id);
          const mine = m.id === user.id;
          if (!p) return <EmptyPick key={m.id} user={m} mine={mine} onAdd={() => setUploading(true)} />;
          return <PickCard key={m.id} pick={p} mine={mine} onOpen={() => setOpenPick(p.id)} />;
        })}
      </div>
      {s.members.length === 1 && (
        <p className="mt-3 text-center text-xs text-muted-foreground">It's just you so far. Share the crew code so your friends show up here.</p>
      )}

      {myPick && (
        <div className="mt-5 flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => setUploading(true)} data-testid="button-change-pick">
            <Camera className="h-4 w-4" /> Change my pick
          </Button>
          <LockButton pick={myPick} onDone={invalidate} />
        </div>
      )}

      <UploadDialog open={uploading} onClose={() => setUploading(false)} sessionId={s.id} hasExisting={!!myPick} onDone={invalidate} />
      <PickDrawer pick={selected} onClose={() => setOpenPick(null)} me={user} onDone={invalidate} />
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

function MatchMeter({ level, label, detail, picked, total, locked }: { level: MatchLevel; label: string; detail: string; picked: number; total: number; locked: number }) {
  const pct = total ? Math.round((picked / total) * 100) : 0;
  return (
    <section className="rounded-2xl border border-card-border bg-card p-4" data-testid="card-match-meter">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Match meter</p>
          <p className="font-display text-xl font-bold" data-testid="text-match-label">{label}</p>
          <p className="text-sm text-muted-foreground">{detail}</p>
        </div>
        <span className={cn("rounded-full px-3 py-1.5 text-sm font-semibold", LEVEL_STYLE[level])}>
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

function PickCard({ pick, mine, onOpen }: { pick: PickView; mine: boolean; onOpen: () => void }) {
  const rx = pick.reactions.filter((r) => r.emoji);
  return (
    <button type="button" onClick={onOpen} className="relative overflow-hidden rounded-2xl border border-card-border bg-card text-left hover-elevate" data-testid={`card-pick-${pick.id}`}>
      <div className="aspect-[3/4] w-full bg-muted">
        <img src={assetUrl(pick.photoPath)} alt={`${pick.user.name}'s pick`} className="h-full w-full object-cover" loading="lazy" />
      </div>
      <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-background/90 py-1 pl-1 pr-2.5 text-xs font-semibold backdrop-blur">
        <Avatar user={pick.user} size="sm" /> {mine ? "You" : pick.user.name}
      </div>
      {pick.locked && (
        <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-accent text-accent-foreground" title="Locked in"><Lock className="h-3.5 w-3.5" /></span>
      )}
      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
        <Swatches colors={pick.palette} size="sm" />
        <span className="text-xs text-muted-foreground">{rx.length > 0 ? rx.map((r) => r.emoji).slice(0, 3).join("") : pick.items.length ? `${pick.items.length} pieces` : ""}</span>
      </div>
    </button>
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
function UploadDialog({ open, onClose, sessionId, hasExisting, onDone }: { open: boolean; onClose: () => void; sessionId: number; hasExisting: boolean; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const m = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Add a photo first");
      const fd = new FormData();
      fd.append("photo", file);
      if (note) fd.append("note", note);
      const res = await apiRequest("POST", `/api/sessions/${sessionId}/picks`, fd);
      return (await res.json()) as PickView & { analysisFailed?: boolean };
    },
    onSuccess: (p) => {
      onDone();
      queryClient.invalidateQueries({ queryKey: ["/api/closet"] });
      reset();
      onClose();
      toast({
        title: "Pick posted",
        description: p.items.length
          ? `Found ${p.items.length} pieces to shop.`
          : p.analysisFailed
            ? "Your crew can see it, but we couldn't read the pieces right now. Try again later or repost."
            : "Your crew can see it. We couldn't make out the pieces; a clearer, well-lit photo works best.",
      });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  function reset() {
    setFile(null);
    setPreview(null);
    setNote("");
  }
  function onFile(f: File | undefined) {
    if (!f) return;
    setFile(f);
    const r = new FileReader();
    r.onload = () => setPreview(r.result as string);
    r.readAsDataURL(f);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-w-sm rounded-2xl">
        <DialogHeader><DialogTitle className="font-display text-xl">{hasExisting ? "Change my pick" : "Post my pick"}</DialogTitle></DialogHeader>
        <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} data-testid="input-photo" />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-2xl border border-dashed border-border bg-muted"
          data-testid="button-choose-photo"
        >
          {preview ? (
            <img src={preview} alt="Outfit preview" className="h-full w-full object-cover" />
          ) : (
            <div className="text-center text-sm text-muted-foreground">
              <Camera className="mx-auto mb-2 h-7 w-7" />
              Tap to take or choose a photo
            </div>
          )}
        </button>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional): 'wearing the new set'" maxLength={200} data-testid="input-note" />
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> We'll pull out the colors and each piece, then link where to shop it.</p>
        {hasExisting && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground" data-testid="text-replace-warning">Replacing your pick clears your crew's reactions and unlocks it.</p>}
        <Button onClick={() => m.mutate()} disabled={!file || m.isPending} className="w-full" size="lg" data-testid="button-post-pick">
          {m.isPending ? "Reading the outfit…" : "Post to crew"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

// ---------- live prices (GET /api/picks/:id/prices) ----------
/** One merchant offer for a garment. `price` is null when the provider can't expose it (e.g. Amazon without PA-API). */
interface PriceOffer {
  title: string;
  seller: string;
  price: number | null;
  priceText: string | null;
  url: string;
  thumbnail?: string | null;
  source: string;
}
interface PricedItem extends GarmentItem {
  offers: PriceOffer[];
}
interface PricesResponse {
  items: PricedItem[];
}

const PRICES_STALE_MS = 10 * 60 * 1000;

/** Fetches live offers once per pick; failures (route missing, provider down) degrade to "no offers" rather than an error state. */
function usePickPrices(pick: PickView | null) {
  return useQuery<PricesResponse>({
    queryKey: ["/api/picks", pick?.id, "prices"],
    enabled: !!pick && pick.items.length > 0,
    staleTime: PRICES_STALE_MS,
    gcTime: PRICES_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

function isAmazon(o: PriceOffer) {
  return /amazon/i.test(o.source) || /amazon/i.test(o.seller) || /amazon\./i.test(o.url);
}

function formatPrice(o: PriceOffer): string | null {
  if (o.priceText) return o.priceText;
  if (o.price != null && Number.isFinite(o.price)) {
    return Number.isInteger(o.price) ? `$${o.price}` : `$${o.price.toFixed(2)}`;
  }
  return null;
}

/** Offers arrive cheapest-first; prefer the first one with a real price so a null-price Amazon row never claims "cheapest". */
function pickCheapest(offers: PriceOffer[]) {
  const priced = offers.find((o) => o.price != null);
  return priced ?? offers[0] ?? null;
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
  const cheapest = pickCheapest(item.offers);
  const others = cheapest ? item.offers.filter((o) => o !== cheapest) : [];
  const cheapestPrice = cheapest ? formatPrice(cheapest) : null;

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
                  <><span className="font-semibold text-primary">Cheapest: {cheapestPrice}</span> <span className="text-muted-foreground">at</span> <span className="font-medium">{cheapest.seller}</span></>
                ) : (
                  <><span className="font-medium">{cheapest.seller}</span> <span className="text-muted-foreground">· <OfferPrice offer={cheapest} /></span></>
                )}
              </p>
              <p className="truncate text-xs text-muted-foreground" title={cheapest.title}>{cheapest.title}</p>
            </div>
            <Button asChild size="sm" className="shrink-0">
              <a href={cheapest.url} target="_blank" rel="noopener sponsored" data-testid={`button-buy-${index}`}>Buy <ExternalLink className="h-3.5 w-3.5" /></a>
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
                      <a href={o.url} target="_blank" rel="noopener sponsored" className="flex items-center justify-between gap-3 px-2.5 py-2 text-sm hover-elevate" data-testid={`link-offer-${index}-${j}`}>
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{o.seller}</span>
                          <span className="block truncate text-xs text-muted-foreground">{o.title}</span>
                        </span>
                        <OfferPrice offer={o} className="shrink-0 text-sm font-semibold" />
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

// ---------- detail drawer ----------
function PickDrawer({ pick, onClose, me, onDone }: { pick: PickView | null; onClose: () => void; me: PublicUser; onDone: () => void }) {
  const [comment, setComment] = useState("");
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
                <Swatches colors={pick.palette} />
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
            {pick.items.length === 0 ? (
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
