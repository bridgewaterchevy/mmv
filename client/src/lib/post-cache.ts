// react-query cache plumbing for Discover posts. Every list that contains posts lives under one of
// two key prefixes so a like / unshare can be mirrored everywhere the post appears:
//   ["discover-feed", vibe | "", sort]   infinite GET /api/discover
//   ["user-posts", handle]               infinite GET /api/users/:handle/posts
//   ["/api/posts", id]                   single GET /api/posts/:id (default queryFn joins the key)
import type { InfiniteData } from "@tanstack/react-query";
import { queryClient } from "./queryClient";
import type { FeedPage, FeedSort, PostView, Vibe } from "./discover";

export const feedKey = (vibe: Vibe | null, sort: FeedSort) => ["discover-feed", vibe ?? "", sort] as const;
export const userPostsKey = (handle: string) => ["user-posts", handle.toLowerCase()] as const;
export const postKey = (id: number) => ["/api/posts", id] as const;
export const postPricesKey = (id: number) => ["/api/posts", id, "prices"] as const;
export const profileKey = (handle: string) => ["/api/users", handle.toLowerCase()] as const;

type Feed = InfiniteData<FeedPage>;

function mapFeed(data: Feed | undefined, fn: (p: PostView) => PostView | null): Feed | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((pg) => ({ ...pg, posts: pg.posts.map(fn).filter((p): p is PostView => p !== null) })),
  };
}

/** Rewrite (or, when `fn` returns null, drop) one post in every cached list and its single-post query. */
export function patchPost(id: number, fn: (p: PostView) => PostView | null) {
  const only = (p: PostView) => (p.id === id ? fn(p) : p);
  queryClient.setQueriesData<Feed>({ queryKey: ["discover-feed"] }, (old) => mapFeed(old, only));
  queryClient.setQueriesData<Feed>({ queryKey: ["user-posts"] }, (old) => mapFeed(old, only));
  queryClient.setQueryData<PostView>(postKey(id), (old) => (old ? (fn(old) ?? undefined) : old));
}

/** Snapshot of a post from any cache, used to roll an optimistic update back. */
export function findCachedPost(id: number): PostView | undefined {
  const single = queryClient.getQueryData<PostView>(postKey(id));
  if (single) return single;
  for (const prefix of ["discover-feed", "user-posts"]) {
    for (const [, data] of queryClient.getQueriesData<Feed>({ queryKey: [prefix] })) {
      const hit = data?.pages.flatMap((pg) => pg.posts).find((p) => p.id === id);
      if (hit) return hit;
    }
  }
  return undefined;
}

export function removePost(id: number) {
  patchPost(id, () => null);
  queryClient.removeQueries({ queryKey: postKey(id), exact: true });
}

/** Mirror a follow toggle onto every cached post by that author. */
export function patchAuthorFollow(handle: string, following: boolean) {
  const h = handle.toLowerCase();
  const fn = (p: PostView) => (p.author.handle.toLowerCase() === h ? { ...p, author: { ...p.author, isFollowedByMe: following } } : p);
  queryClient.setQueriesData<Feed>({ queryKey: ["discover-feed"] }, (old) => mapFeed(old, fn));
  queryClient.setQueriesData<Feed>({ queryKey: ["user-posts"] }, (old) => mapFeed(old, fn));
  queryClient.setQueriesData<PostView>({ queryKey: ["/api/posts"] }, (old) => (old && typeof old === "object" && "author" in old ? fn(old) : old));
}

/** Drop a fresh post (from POST /api/picks/:id/share) at the top of the "new" feeds so it shows up at once. */
export function prependPost(post: PostView) {
  queryClient.setQueryData<PostView>(postKey(post.id), post);
  queryClient.setQueriesData<Feed>({ queryKey: ["discover-feed"] }, (old) => {
    if (!old || !old.pages.length) return old;
    const [first, ...rest] = old.pages;
    if (first.posts.some((p) => p.id === post.id)) return old;
    return { ...old, pages: [{ ...first, posts: [post, ...first.posts] }, ...rest] };
  });
  queryClient.invalidateQueries({ queryKey: ["discover-feed"] });
  queryClient.invalidateQueries({ queryKey: userPostsKey(post.author.handle) });
  queryClient.invalidateQueries({ queryKey: profileKey(post.author.handle) });
}
