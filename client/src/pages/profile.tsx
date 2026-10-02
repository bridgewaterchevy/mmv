// #/u/:handle — public profile: name, @handle, bio, counts, Follow toggle, grid of shared fits.
// Own profile gets an inline "Edit bio" (PATCH /api/me { bio }).
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Check, Compass, Heart, Images, Pencil, UserPlus, UserCheck, Share2 } from "lucide-react";
import { Avatar, Page, type AvatarUser } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { apiJson, assetUrl, errorStatus, queryClient } from "@/lib/queryClient";
import { copyText } from "@/lib/invite";
import { cn } from "@/lib/utils";
import { BIO_MAX, formatCount, profileUrl, userPostsPath, type FeedPage, type ProfileView } from "@/lib/discover";
import { patchAuthorFollow, profileKey, userPostsKey } from "@/lib/post-cache";
import { useGate } from "@/components/sign-in-prompt";

export default function ProfilePage({ params }: { params: { handle: string } }) {
  const handle = decodeURIComponent(params.handle).replace(/^@/, "").toLowerCase();
  const { user } = useAuth();
  const q = useQuery<ProfileView>({ queryKey: profileKey(handle) });
  const posts = useInfiniteQuery<FeedPage, Error, { pages: FeedPage[]; pageParams: unknown[] }, readonly unknown[], string | null>({
    queryKey: userPostsKey(handle),
    queryFn: ({ pageParam }) => apiJson<FeedPage>("GET", userPostsPath(handle, pageParam)),
    initialPageParam: null,
    getNextPageParam: (last) => (last?.nextCursor ? last.nextCursor : undefined),
    enabled: !!q.data,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const all = posts.data?.pages.flatMap((p) => p?.posts ?? []) ?? [];

  // Load the next page when the sentinel scrolls into view (the page itself scrolls the window).
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !posts.hasNextPage) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !posts.isFetchingNextPage) posts.fetchNextPage();
    }, { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [posts.hasNextPage, posts.isFetchingNextPage, posts.fetchNextPage, posts]);

  if (q.isLoading) {
    return (
      <Page title=" " back="/discover">
        <div className="flex items-center gap-4"><Skeleton className="h-16 w-16 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-5 w-32" /><Skeleton className="h-3 w-20" /></div></div>
        <div className="mt-6 grid grid-cols-3 gap-1.5">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="aspect-[3/4] rounded-xl" />)}</div>
      </Page>
    );
  }
  if (!q.data) {
    return (
      <Page title={`@${handle}`} back="/discover">
        <div className="rounded-2xl border border-dashed border-border p-8 text-center" data-testid="profile-not-found">
          <p className="font-semibold">{errorStatus(q.error) === 404 ? "No one here by that handle" : "Couldn't load this profile"}</p>
          <p className="mt-1 text-sm text-muted-foreground">{errorStatus(q.error) === 404 ? "Check the spelling, or browse Discover." : q.error?.message}</p>
          <Button asChild variant="outline" className="mt-4"><Link href="/discover"><Compass className="h-4 w-4" /> Discover</Link></Button>
        </div>
      </Page>
    );
  }

  const p = q.data;
  const isMe = p.isMe || (!!user && user.id === p.id);
  const asUser: AvatarUser = { id: p.id, name: p.name, color: p.color };

  return (
    <Page title={p.name} back="/discover" action={<ShareProfileButton handle={p.handle} />}>
      <header className="rounded-2xl border border-card-border bg-card p-4" data-testid="card-profile">
        <div className="flex items-start gap-4">
          <Avatar user={asUser} size="lg" className="text-xl" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-xl font-bold leading-tight" data-testid="text-profile-name">{p.name}</h2>
            <p className="truncate text-sm text-muted-foreground" data-testid="text-profile-handle">@{p.handle}</p>
            <dl className="mt-2 flex gap-4 text-sm" data-testid="row-profile-counts">
              <Stat n={p.postCount} label={p.postCount === 1 ? "fit" : "fits"} testId="text-count-posts" />
              <Stat n={p.followerCount} label={p.followerCount === 1 ? "follower" : "followers"} testId="text-count-followers" />
              <Stat n={p.followingCount} label="following" testId="text-count-following" />
            </dl>
          </div>
        </div>
        <Bio profile={p} isMe={isMe} />
        <div className="mt-3">
          {isMe ? (
            <Button asChild variant="outline" className="w-full" data-testid="button-share-from-crews">
              <Link href="/"><Compass className="h-4 w-4 text-primary" /> Share a fit from a crew</Link>
            </Button>
          ) : (
            <FollowButton profile={p} />
          )}
        </div>
      </header>

      <h3 className="mb-2 mt-5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><Images className="h-3.5 w-3.5" /> Shared fits</h3>
      {posts.isLoading ? (
        <div className="grid grid-cols-3 gap-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="aspect-[3/4] rounded-xl" />)}</div>
      ) : all.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center" data-testid="empty-profile-posts">
          <Compass className="mx-auto mb-2 h-7 w-7 text-muted-foreground" />
          <p className="font-semibold">{isMe ? "You haven't shared a fit yet" : `${p.name} hasn't shared a fit yet`}</p>
          <p className="mt-1 text-sm text-muted-foreground">{isMe ? "Open one of your picks in a crew and tap Share to Discover." : "Follow to catch the first one."}</p>
        </div>
      ) : (
        <>
          <ul className="grid grid-cols-3 gap-1.5" data-testid="grid-profile-posts">
            {all.map((post) => (
              <li key={post.id}>
                <Link href={`/p/${post.id}`} className="group relative block aspect-[3/4] overflow-hidden rounded-xl bg-muted" data-testid={`tile-post-${post.id}`}>
                  {post.photos[0] ? (
                    <img src={assetUrl(post.photos[0].url)} alt={post.caption ?? `${p.name}'s fit`} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" loading="lazy" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-muted-foreground"><Images className="h-5 w-5" /></span>
                  )}
                  {post.photos.length > 1 && <Images className="absolute right-1.5 top-1.5 h-3.5 w-3.5 text-white drop-shadow" aria-label={`${post.photos.length} photos`} />}
                  <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
                    <Heart className={cn("h-3 w-3", post.likedByMe && "fill-current")} /> {formatCount(post.likeCount)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <div ref={sentinel} className="h-6" aria-hidden />
          {posts.isFetchingNextPage && <p className="text-center text-xs text-muted-foreground">Loading more…</p>}
        </>
      )}
    </Page>
  );
}

function Stat({ n, label, testId }: { n: number; label: string; testId: string }) {
  return (
    <div className="flex items-baseline gap-1" data-testid={testId}>
      <dd className="font-bold tabular-nums">{formatCount(n)}</dd>
      <dt className="text-xs text-muted-foreground">{label}</dt>
    </div>
  );
}

function ShareProfileButton({ handle }: { handle: string }) {
  const { toast } = useToast();
  return (
    <Button size="icon" variant="ghost" className="rounded-full" aria-label="Copy profile link" onClick={async () => { toast({ title: (await copyText(profileUrl(handle))) ? "Profile link copied" : profileUrl(handle) }); }} data-testid="button-share-profile">
      <Share2 className="h-5 w-5" />
    </Button>
  );
}

// ---------- follow ----------
/** POST /api/users/:handle/follow (toggle). Optimistic on the profile; mirrored onto cached posts by this author. */
export function useFollow(handle: string) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: () => apiJson<{ following: boolean; followerCount: number }>("POST", `/api/users/${encodeURIComponent(handle)}/follow`),
    onMutate: () => {
      const before = queryClient.getQueryData<ProfileView>(profileKey(handle));
      if (before) {
        const following = !before.isFollowedByMe;
        queryClient.setQueryData<ProfileView>(profileKey(handle), { ...before, isFollowedByMe: following, followerCount: Math.max(0, before.followerCount + (following ? 1 : -1)) });
        patchAuthorFollow(handle, following);
      }
      return { before };
    },
    onSuccess: (res) => {
      if (res && typeof res.following === "boolean") {
        queryClient.setQueryData<ProfileView>(profileKey(handle), (old) => (old ? { ...old, isFollowedByMe: res.following, followerCount: typeof res.followerCount === "number" ? res.followerCount : old.followerCount } : old));
        patchAuthorFollow(handle, res.following);
      }
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.before) { queryClient.setQueryData(profileKey(handle), ctx.before); patchAuthorFollow(handle, ctx.before.isFollowedByMe); }
      toast({ title: e.message || "Couldn't update follow", variant: "destructive" });
    },
  });
}

function FollowButton({ profile }: { profile: ProfileView }) {
  const gate = useGate();
  const m = useFollow(profile.handle);
  const on = profile.isFollowedByMe;
  return (
    <Button
      className="w-full"
      variant={on ? "secondary" : "default"}
      onClick={gate("follow", () => m.mutate())}
      aria-pressed={on}
      data-testid="button-follow"
      data-following={on ? "true" : "false"}
    >
      {on ? <><UserCheck className="h-4 w-4" /> Following</> : <><UserPlus className="h-4 w-4" /> Follow</>}
    </Button>
  );
}

// ---------- bio ----------
function Bio({ profile, isMe }: { profile: ProfileView; isMe: boolean }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile.bio ?? "");
  const m = useMutation({
    mutationFn: () => apiJson<Partial<ProfileView>>("PATCH", "/api/me", { bio: draft.trim() || null }),
    onSuccess: (res) => {
      const bio = typeof res?.bio === "string" || res?.bio === null ? res.bio : draft.trim() || null;
      queryClient.setQueryData<ProfileView>(profileKey(profile.handle), (old) => (old ? { ...old, bio } : old));
      setEditing(false);
      toast({ title: "Bio saved" });
    },
    onError: (e: Error) => toast({ title: e.message || "Couldn't save your bio", variant: "destructive" }),
  });

  if (editing) {
    return (
      <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }} data-testid="form-edit-bio">
        <Textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value.slice(0, BIO_MAX))} maxLength={BIO_MAX} rows={2} placeholder="6am lifter. Sage sets and white Metcons." className="min-h-[3.25rem] resize-none rounded-xl" data-testid="input-bio" />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] tabular-nums text-muted-foreground">{BIO_MAX - draft.length}</span>
          <span className="flex gap-1.5">
            <Button type="button" size="sm" variant="outline" onClick={() => { setEditing(false); setDraft(profile.bio ?? ""); }} data-testid="button-cancel-bio">Cancel</Button>
            <Button type="submit" size="sm" disabled={m.isPending} data-testid="button-save-bio"><Check className="h-3.5 w-3.5" /> {m.isPending ? "Saving…" : "Save"}</Button>
          </span>
        </div>
      </form>
    );
  }
  return (
    <div className="mt-3 flex items-start justify-between gap-2">
      {profile.bio ? (
        <p className="text-sm leading-snug" data-testid="text-profile-bio">{profile.bio}</p>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="text-profile-bio">{isMe ? "Add a line about your style." : "No bio yet."}</p>
      )}
      {isMe && (
        <button type="button" onClick={() => { setDraft(profile.bio ?? ""); setEditing(true); }} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-secondary px-2.5 text-xs font-semibold text-secondary-foreground hover-elevate" data-testid="button-edit-bio">
          <Pencil className="h-3 w-3" /> Edit bio
        </button>
      )}
    </div>
  );
}
