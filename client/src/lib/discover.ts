// Discover feed contract (public posts shared from picks). Pure helpers, no React.
//
//   GET    /api/discover?cursor=&vibe=&sort=new|top → { posts: PostView[], nextCursor }   (public; token optional)
//   GET    /api/posts/:id                            → PostView                            (public)
//   GET    /api/posts/:id/prices                     → { items: PricedItem[] }             (public; same shape as /api/picks/:id/prices)
//   POST   /api/posts/:id/like                       → { likeCount, likedByMe }            (toggle; auth)
//   POST   /api/posts/:id/report { reason }          → 2xx                                 (auth)
//   DELETE /api/posts/:id                            → 2xx                                 (owner)
//   POST   /api/picks/:id/share { caption, vibe, photoIds } → 201 PostView                 (owner)
//   GET    /api/users/:handle                        → ProfileView                         (public)
//   GET    /api/users/:handle/posts?cursor=          → { posts: PostView[], nextCursor }   (public)
//   POST   /api/users/:handle/follow                 → { following, followerCount }        (toggle; auth)
//   PATCH  /api/me { bio }
import type { GarmentItem } from "@shared/schema";
import type { AnalysisStatus } from "./analysis";

export const VIBES = ["gym", "run", "pickleball", "golf", "date-night", "girls-night", "guys-night", "brunch", "travel", "other"] as const;
export type Vibe = (typeof VIBES)[number];

export const VIBE_LABEL: Record<Vibe, string> = {
  gym: "Gym",
  run: "Run",
  pickleball: "Pickleball",
  golf: "Golf",
  "date-night": "Date night",
  "girls-night": "Girls' night",
  "guys-night": "Guys' night",
  brunch: "Brunch",
  travel: "Travel",
  other: "Other",
};

export const VIBE_EMOJI: Record<Vibe, string> = {
  gym: "💪",
  run: "🏃‍♀️",
  pickleball: "🥒",
  golf: "⛳",
  "date-night": "🍷",
  "girls-night": "💃",
  "guys-night": "🍻",
  brunch: "🥂",
  travel: "✈️",
  other: "✨",
};

export function isVibe(v: unknown): v is Vibe {
  return typeof v === "string" && (VIBES as readonly string[]).includes(v);
}

/** Human label for a vibe; unknown values (older posts, new server vibes) fall back to the raw string. */
export function vibeLabel(v: string | null | undefined): string {
  if (!v) return "";
  return isVibe(v) ? VIBE_LABEL[v] : v.replace(/-/g, " ");
}

export type FeedSort = "new" | "top";

export interface PostAuthor {
  id: number;
  name: string;
  handle: string;
  color: string;
  isFollowedByMe: boolean;
}

export interface PostPhoto {
  id: number;
  url: string;
}

export interface PostView {
  id: number;
  caption: string | null;
  vibe: Vibe | string;
  createdAt: string;
  likeCount: number;
  likedByMe: boolean;
  photos: PostPhoto[];
  items: GarmentItem[];
  palette: string[];
  analysisStatus?: AnalysisStatus;
  author: PostAuthor;
  isMine: boolean;
}

export interface FeedPage {
  posts: PostView[];
  nextCursor: string | null;
}

export interface ProfileView {
  id: number;
  name: string;
  handle: string;
  color: string;
  bio: string | null;
  followerCount: number;
  followingCount: number;
  postCount: number;
  isFollowedByMe: boolean;
  isMe: boolean;
}

export const CAPTION_MAX = 140;
export const BIO_MAX = 160;
export const FEED_PAGE_SIZE_HINT = 10;

/** Query string for GET /api/discover. Empty filters are omitted so the key stays stable. */
export function discoverPath(opts: { cursor?: string | null; vibe?: Vibe | null; sort?: FeedSort }): string {
  const q = new URLSearchParams();
  if (opts.cursor) q.set("cursor", opts.cursor);
  if (opts.vibe) q.set("vibe", opts.vibe);
  if (opts.sort && opts.sort !== "new") q.set("sort", opts.sort);
  const s = q.toString();
  return `/api/discover${s ? `?${s}` : ""}`;
}

export function userPostsPath(handle: string, cursor?: string | null): string {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return `/api/users/${encodeURIComponent(handle)}/posts${q}`;
}

/** Full, shareable permalink: <origin><pathname>#/p/<id>. Same shape as inviteUrl (never hardcode the host). */
export function postUrl(id: number): string {
  const base = `${window.location.origin}${window.location.pathname}`.replace(/\/+$/, "");
  return `${base}/#/p/${id}`;
}

export function profileUrl(handle: string): string {
  const base = `${window.location.origin}${window.location.pathname}`.replace(/\/+$/, "");
  return `${base}/#/u/${encodeURIComponent(handle)}`;
}

/** Hash paths that render without a token: the feed, a post permalink and a profile. */
export function isPublicPath(path: string): boolean {
  return /^\/discover(\/|$|\?)/.test(path) || path === "/discover" || /^\/p\/\d+/.test(path) || /^\/u\/[^/]+/.test(path);
}

/** "2h", "3d", "Sep 12" — compact relative time for the author chip. */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  const date = new Date(t);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }) });
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** Shallow toggle of the like state; used for optimistic cache updates before the server answers. */
export function toggleLike<T extends { likeCount: number; likedByMe: boolean }>(p: T): T {
  return { ...p, likedByMe: !p.likedByMe, likeCount: Math.max(0, p.likeCount + (p.likedByMe ? -1 : 1)) };
}

// ---------- return-to after sign-in ----------
// A logged-out visitor taps Like on Discover → we stash the current hash, send them to Welcome, and the
// auth provider brings them back here once they're in.
const RETURN_KEY = "mmv.returnTo";
let memoryReturn: string | null = null;

function safeSession(): Storage | null {
  try {
    const s = window.sessionStorage;
    s.getItem(RETURN_KEY);
    return s;
  } catch {
    return null;
  }
}

export function setReturnTo(hashPath: string | null) {
  const v = hashPath && isPublicPath(hashPath) ? hashPath : null;
  memoryReturn = v;
  const s = safeSession();
  if (!s) return;
  if (v) s.setItem(RETURN_KEY, v);
  else s.removeItem(RETURN_KEY);
}

/** Read and clear the stashed path (or null). */
export function consumeReturnTo(): string | null {
  const v = memoryReturn ?? safeSession()?.getItem(RETURN_KEY) ?? null;
  setReturnTo(null);
  return v && isPublicPath(v) ? v : null;
}

export const REPORT_REASONS = [
  { value: "spam", label: "Spam or ads" },
  { value: "inappropriate", label: "Inappropriate photo" },
  { value: "not-outfit", label: "Not an outfit" },
  { value: "other", label: "Something else" },
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number]["value"];
