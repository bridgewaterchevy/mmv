# Discover — public shoppable posts, likes, follows, reports, admin moderation (backend handoff, 2026-10-01)

Commit: "Discover: public shoppable posts, likes, follows, reports, admin moderation". Files: `shared/schema.ts`,
`server/db.ts`, `server/storage.ts`, `server/discover.ts` (new), `server/routes.ts`, `tests/smoke.py`,
`tests/mock_api.py`, `tests/test_discover_mock.py` (new). Builds on `docs/multi-photo-backend-20261001.md` (pick
photos / aggregates) and `docs/shopping-hints-backend-20261001.md` (prices pipeline).

## What it is

A **post** is the public face of one pick. The owner picks which of the pick's photos go public, adds a caption
(≤ 140) and a vibe tag; anyone — signed in or not — can browse `/api/discover`, open a post, see the pick's
recognised items and palette, **shop the prices**, like it, follow the author and report it. Exactly one post per
pick. Nothing private (pick note, crew, session, invite code, non-chosen photos, owner `shopFor`) ever leaves the
server on a public route; `tests/test_discover_mock.py` asserts this on every public payload.

## Types (exported from `@shared/schema`)

| export | notes |
| --- | --- |
| `POST_VIBES` / `PostVibe` | `gym, run, pickleball, golf, date-night, girls-night, guys-night, brunch, travel, other` |
| `POST_STATUSES` / `PostStatus` | `active` (public) · `hidden` (not listed; auto after 3 reports or no public photo left) · `removed` (owner/admin delete) |
| `POST_STATUS_REASONS` | `reports`, `no_photos`, `owner`, `admin` — why a post is not active. `reports`/`admin` are **sticky**: the owner re-sharing does not reactivate; an admin must. |
| `POST_CAPTION_MAX` 140, `POST_REPORT_REASON_MAX` 200, `POST_REPORTS_TO_HIDE` 3, `DISCOVER_PAGE_SIZE` 12, `DISCOVER_TOP_WINDOW_DAYS` 30, `DISCOVER_SORTS` `new\|top`, `USER_BIO_MAX` 120 | constants |
| `PostView` | see below |
| `PostAuthor` | `{ id, name, handle, color, isFollowedByMe }` — `name` is the **first name only** (everything after the first space dropped) |
| `DiscoverPage` | `{ posts: PostView[], nextCursor: string \| null }` |
| `PublicProfile` | `{ id, name (first), handle, color, bio, followerCount, followingCount, postCount, isFollowedByMe, isMe }` |
| `PostReportView` | admin row: report + `reporter {id,name,handle} \| null` + `postStatus` + `postAuthorHandle` |
| `sharePostBodySchema`, `postReportBodySchema`, `postStatusSchema`, `bioSchema` | zod |
| tables `posts`, `postLikes`, `follows`, `postReports`; `users.bio` | drizzle |

### `PostView`

```ts
{
  id: number; caption: string | null; vibe: PostVibe; createdAt: string /* ISO */;
  likeCount: number; likedByMe: boolean /* false when anonymous */;
  photos: { id: number; url: string }[];   // ONLY the photos the owner chose, in pick position order
  items: GarmentItem[];                     // the pick's aggregated items, decorated like PickView.items (shoppingQuery, hinted + affiliate links)
  palette: string[]; analysisStatus: "pending" | "ready" | "failed";
  author: { id; name /* first name */; handle; color; isFollowedByMe };
  isMine: boolean; status: PostStatus;
  pickId: number | null;                    // only for the owner / admins, null for everyone else
}
```

Not in it, on purpose: pick `note`, `sessionId`, `userId`, `locked`, `analysisError`, reactions, crew/session, the
author's `shopFor`/full name, un-chosen photos.

## Endpoints (all JSON; every non-prices route sends `Cache-Control: no-store`)

"public" = no token needed; a valid `x-auth-token` personalises (`likedByMe`, `author.isFollowedByMe`, `isMine`,
`pickId`); a bogus token is treated as anonymous (never 401).

| method/path | auth | body / query | response |
| --- | --- | --- | --- |
| `POST /api/picks/:id/share` | **owner** | `{ vibe, caption?, photoIds? }` | **201** `PostView`. Creates or updates the pick's single post. `photoIds` must be ids from `PickView.photos` (else 400 `{ message, photoId }`); omitted on create = all photos; omitted on update = keep the selection (or all photos again if nothing of it survived). Blank caption → `null`. Reactivates a hidden/removed post **unless** reason is `reports`/`admin` (then it is updated but `status` stays — show "under review"). 400 bad vibe / caption > 140 / empty `photoIds` · 403 non-owner · 404 · 429 (30/h/user). |
| `DELETE /api/posts/:id` | owner **or admin** | — | `{ ok: true, id, status: "removed" }`. Owner → reason `owner` (re-share brings it back); admin → `admin` (sticky). 403 / 404 (also when already removed). |
| `GET /api/discover` | public | `?sort=new\|top&vibe=<PostVibe>&cursor=` | `DiscoverPage`, **12 per page**, only `active`. `new` = created desc. `top` = like_count desc, created desc, **last 30 days only**. `cursor` is opaque (pass `nextCursor` back); malformed → 400; bad sort/vibe → 400. |
| `GET /api/posts/:id` | public | — | `PostView`. **404** when hidden/removed unless the viewer is the owner or an admin (they get it with `status`). |
| `GET /api/posts/:id/prices` | public | — | `{ postId, items: PricedItem[] }` — the **exact** pipeline of `GET /api/picks/:id/prices` (first 4 items, same daily budget `PRICE_LOOKUPS_PER_DAY`, same 24h `price_cache` keyed by the owner-hinted `shoppingQuery`, same affiliate wrapping, Amazon price hidden). Rate limit **30/h/IP** → 429. Same visibility rule as `GET /api/posts/:id`. |
| `POST /api/posts/:id/like` | auth | — | toggle → `{ likeCount, likedByMe }`. 404 unless the post is active. 429 at 300/h/user. |
| `POST /api/posts/:id/report` | **optional** | `{ reason }` (1–200) | **201** `{ id, reportCount, hidden }`. One row per reporter (`u:<id>` or `ip:<ip>`): reporting twice updates the reason, does not count again. At **3 distinct reporters** the post flips to `hidden` (reason `reports`) and the server logs `[discover] post N auto-hidden after 3 distinct reports`. 400 own post / empty / too long · 404 unknown or removed · **429 5/h/IP**. |
| `GET /api/users/:handle` | public | `@` prefix and any case accepted | `PublicProfile` (`postCount` = active posts). 404 unknown. |
| `GET /api/users/:handle/posts` | public | `?cursor=` | `DiscoverPage` of that user's active posts (owner/admin also see the user's `hidden` ones, never `removed`). |
| `POST /api/users/:handle/follow` | auth | — | toggle → `{ following, followerCount }`. 400 self · 404 · 429 at 120/h/user. |
| `GET /api/me` | auth | — | PublicUser + `isAdmin` + **`postCount`, `followerCount`, `followingCount`** (new). PublicUser now also carries `bio`. |
| `PATCH /api/me` | auth | `{ shopFor?, bio? }` — at least one key | PublicUser. `bio` ≤ 120, trimmed; `""`/`null` clears. `{}` → 400 (unchanged behaviour for `shopFor` alone). |
| `GET /api/admin/posts` | admin | `?status=active\|hidden\|removed` | `(PostView & { reportCount, statusReason })[]`, every status when no filter, newest-updated first, max 100, `pickId` filled. 400 bad status · 403 non-admin. |
| `PATCH /api/admin/posts/:id` | admin | `{ status }` | `PostView & { statusReason }`. `active` clears the reason; `hidden`/`removed` set reason `admin` (sticky). Logged. 400 / 404. |
| `GET /api/admin/reports` | admin | — | `PostReportView[]`, newest 200. |

Admin = handle in `ADMIN_HANDLES` (same `isAdmin` helper as feedback).

### Suggested client flow

Share sheet on an owned pick → `POST /api/picks/:id/share` with the ticked `photos[].id`s; if the response
`status !== "active"` show "under review / removed by moderators". Feed: `GET /api/discover?sort=…&vibe=…`,
infinite-scroll with `nextCursor`. Post page: `GET /api/posts/:id` then lazily `GET /api/posts/:id/prices` (works for
anonymous visitors, so share links convert). Heart → `POST like`, use the returned counts. Author chip →
`GET /api/users/:handle` (+ `/posts`), follow button → `POST follow`. "Report" → `POST report` (works anonymously).
Owner's "remove from Discover" → `DELETE /api/posts/:id`. Admin screen: `/api/admin/posts?status=hidden` +
`/api/admin/reports`, `PATCH` to resolve.

## Server behaviour

- **Schema** (`server/db.ts`, idempotent DDL): `users.bio` (ALTER ADD COLUMN IF NOT EXISTS); `posts (id, pick_id UNIQUE
  → picks ON DELETE CASCADE, user_id, caption, vibe, photo_ids jsonb int[], like_count, status, status_reason,
  created_at, updated_at)` with indexes for new/top/vibe/user listing; `post_likes (post_id → posts CASCADE, user_id,
  UNIQUE(post_id,user_id))`; `follows (follower_id, followee_id, UNIQUE pair)`; `post_reports (post_id → posts CASCADE,
  user_id NULL, reporter_key, reason, UNIQUE(post_id, reporter_key))`.
- **Cascades**: `storage.deletePick` deletes the post explicitly (likes/reports cascade from it; the FK would too).
  `storage.deletePhoto` and a re-post (`upsertPick` on an existing pick) call `syncPostPhotos`: ids of vanished photos
  are dropped from `photo_ids`; when none are left the post becomes `hidden` (reason `no_photos`, logged). Re-sharing
  with new `photoIds` (or none → all photos) reactivates.
- **Pagination**: keyset cursors (`base64url(JSON {t: created_at ms, i: id, l?: like_count})`) with Postgres row
  comparisons `(created_at, id) < (…)` / `(like_count, created_at, id) < (…)`, so inserts between pages never shift
  or duplicate items. 12/page (`DISCOVER_PAGE_SIZE`).
- **Views**: `storage.postViews(rows, viewer, {admin})` builds a page with a fixed number of queries (picks, photos,
  authors, viewer likes, viewer follows). Items are aggregated from the photo rows exactly like `PickView` and
  decorated with `applyShoppingHints(items, owner)` + `wrapItems`, so `shoppingQuery`/links match what the crew sees.
- **Prices**: `routes.ts` now exposes one `priceItems(view)` used by both `GET /api/picks/:id/prices` and
  `GET /api/posts/:id/prices` — one budget, one cache, one affiliate layer.
- **Rate limits** (in-memory `limited()`): share 30/h/user, like 300/h/user, follow 120/h/user, post prices
  30/h/IP, report 5/h/IP. `ip()` honours `x-forwarded-for` like the rest of the API.
- **Logs**: `[discover] post N auto-hidden after K distinct reports (latest: "…")`, `[discover] post N hidden: no
  public photo left on pick P`, `[discover] admin @h set post N a -> b`, `[discover] admin @h removed post N`.

## Tests / results (2026-10-01, local)

| run | result |
| --- | --- |
| `npx tsc --noEmit -p .` | clean for `server/**`, `shared/**`, `tests/**` (one pre-existing error in `client/src/pages/session.tsx` from the concurrent client work: missing `@/components/share-discover`). |
| `python tests/test_discover_mock.py` | **168/168** — share validation/defaults/updates, pagination (12 + 4, no overlap, newest first, bad cursor 400), vibe filter, top sort (4/2/1 likes then ties newest-first, cursor on top), anonymous read + bogus token, like toggle, follow toggle/self/unknown, profile + bio + `/api/me` counts, report flow (same reporter counted once, 3rd distinct → hidden, owner/admin still see it, sticky on re-share, 5/h/IP), admin list/filter/PATCH/reports/delete, owner delete + re-share, photo-removal / re-post / pick-deletion cascades, prices via post (same offers as the crew route with `PRICE_LOOKUPS_PER_DAY=1` → shared budget + cache, 30/h/IP), privacy sweep on every public payload, server log has no `Internal Server Error`. |
| `python tests/smoke.py --no-feedback` against `npm run dev` on :5000 | **193/193** (new Discover block: share 401/403/400/201, feed/post/prices anonymous, privacy, like, follow, profile, bio, report, admin 403s, owner delete). Saved `tests/smoke-local-run-2026-10-01-discover.json`. |
| `python tests/smoke.py --base http://localhost:5999 --no-feedback` against `tests/mock_api.py` | **193/193** — the mock now implements the Discover contract too. Saved `tests/smoke-mock-run-2026-10-01-discover.json`. |
| `tests/test_prices_mock.py` / `tests/test_feedback_mock.py` / `tests/test_analysis_mock.py` | 133/133 · 109/109 · 93/93 (no regressions). |

## Caveats / decisions

- `PATCH /api/me` previously required `shopFor`; it now requires **at least one** of `shopFor` / `bio`. `{}` is still 400.
- `PublicUser` (crew member lists, reactions, `/api/me`) now includes `bio`. Nothing else about crew payloads changed.
- A post hidden by **reports** or by an **admin** cannot be reactivated by the owner (re-share updates caption/photos
  but keeps the status). Owner-removed and no-photos-hidden posts come back on re-share. Admin can set any status.
- `top` only considers the last 30 days, so a 31-day-old post with many likes disappears from `top` (still in `new`).
- Rate limits are per process (in-memory) like the existing ones; on a multi-instance deploy they are per instance.
- Anonymous reports are keyed by IP; people behind one NAT count as one reporter (deliberate: harder to brigade).
- `GET /api/users/:handle/posts` for the owner/admin includes the user's `hidden` posts (so owners can see what is
  under review); `profile.postCount` counts active only.
- `status` and `pickId` were added to `PostView` beyond the requested shape (owner/admin need them for the UI);
  `pickId` is `null` for everyone else. `post_reports` gained `reporter_key` to make "distinct reports" well-defined.
- Items in public posts carry the owner's department hint (`women's …`) in `shoppingQuery`; that is intended (the
  outfit is theirs) and it is the only trace of `shopFor` — the field itself is not exposed.
