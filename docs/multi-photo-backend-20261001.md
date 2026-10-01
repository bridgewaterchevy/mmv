# Multiple photos per pick — backend handoff (2026-10-01)

Commit: "Picks: multiple photos per pick (full outfit or single pieces)". Files: `shared/schema.ts`, `server/db.ts`,
`server/storage.ts`, `server/aggregate.ts` (new), `server/analysis.ts`, `server/routes.ts`, `server/vision.ts`,
`tests/smoke.py`, `tests/mock_api.py`, `tests/test_analysis_mock.py`, `docs/RUNBOOK.md`. Builds on
`docs/async-picks-backend-20261001.md` (background analysis), which still applies except where noted here.

## What changed for the client

A pick now holds **1–6 photos** (`PICK_MAX_PHOTOS`, default 6): full-outfit shots and/or single pieces (laid flat, on a
hanger, held up). Every photo is analysed on its own; the pick shows **one** merged garment list, one palette and one
status.

### PickView — new/changed fields (every place a pick is returned)

| field | type | notes |
| --- | --- | --- |
| `photos` | `PickPhotoView[]` | **new.** Ordered by `position`; `photos[0]` is the cover. Shape: `{ id, url, position, analysisStatus, analysisError, itemCount }`. Types exported from `@shared/schema` (`PickPhotoView`, `PickPhoto`, `PICK_MAX_PHOTOS_DEFAULT`, `PICK_MAX_ITEMS`, `PICK_MAX_PALETTE`). |
| `photoPath` | string | unchanged meaning for old code: **= `photos[0].url`** (cover). Moves when the cover is deleted. |
| `items` | `GarmentItem[]` | now an **aggregate**: photo items concatenated in position order, near-duplicates merged (same category + similar colour or similar searchQuery; a merged duplicate donates its `brandGuess` if the kept one has none), **max 12**. Still decorated at read time (`shoppingQuery`, hinted links, affiliate wrapping). |
| `palette` | `string[]` | aggregate: distinct hexes (case-insensitive) in position order, **max 6**. |
| `analysisStatus` | `pending \| ready \| failed` | aggregate: `pending` if **any** photo is pending, else `ready` if any photo is ready, else `failed`. So a pick stays `pending` until the last photo settles; a pick with one good photo and one failed one is `ready`. |
| `analysisError` | `string \| null` | first failed photo's error **only when no photo is ready**; otherwise `null` (look at `photos[i].analysisError` for per-photo failures). |
| `analysisFailed` | boolean | still `=== (analysisStatus === "failed")`. |
| `analyzedAt` | ISO \| null | latest photo `analyzedAt`. |
| `note` | string \| null | the owner's text; when blank, the **first ready photo's** one-line summary (cover first). Stored `picks.note` is now the user text only — the summary lives per photo (`pick_photos.summary`). |

While some photos are still pending, `items`/`palette` already contain the pieces of the photos that are ready (so
the UI can fill in progressively); the previous items of a photo being retried stay visible until the retry lands.

### Endpoints (all `Cache-Control: no-store`)

| method/path | auth | response | notes |
| --- | --- | --- | --- |
| `POST /api/sessions/:id/picks` (multipart, field `photo` **×1–6**, optional `note`) | crew member | **201** `PickView`, `analysisStatus: "pending"`, `photos[]` all pending | Unchanged for a single file. Every file is magic-byte sniffed; one bad file → 400, nothing stored. 7+ files → **400** `"Up to 6 photos per pick"`. Re-posting replaces the whole pick (same id, all photos, reactions cleared). Rate limit 20 requests/h/user as before. |
| `GET /api/picks/:id` | crew member | 200 `PickView` + `photos` | poll target, unchanged otherwise |
| `POST /api/picks/:id/photos` (multipart `photo` ×1–N) | **owner** | **201** `PickView` | appends photos (positions continue), queues their analysis → pick goes back to `pending`. **400** `{ message, max: 6, current: n }` when `current + N > 6`; 400 no file / unreadable file; 403 non-owner; 404 unknown pick; 401 no token; 429 shares the upload limiter. |
| `DELETE /api/picks/:id/photos/:photoId` | **owner** | 200 `PickView` | removes the photo row, renumbers positions `0..n-1` (order kept), recomputes aggregates, deletes the stored file best-effort. **400** `"A pick needs at least one photo - delete the pick instead"` for the last photo. 404 when the photo is not part of that pick. |
| `POST /api/picks/:id/photos/:photoId/analyze` | **owner** | 200 `PickView` (that photo `pending`) | per-photo retry. **202** + current view if that photo is already pending. 429 after 10 retries/h/user (shared with the pick-level retry). 404 unknown photo / 403 / 401. |
| `POST /api/picks/:id/analyze` | **owner** | 200 `PickView` | now re-queues **every failed photo**, or **all photos when none failed**. 202 + current view when any photo is already pending. Same 403/404/429 as before. |
| `DELETE /api/picks/:id` | owner | `{ ok: true }` | removes all photo files |
| `GET /api/sessions/:id`, `GET /api/crews/:id/day/:date`, `GET /api/closet` | member | `picks[]` carry `photos[]` | photos are loaded in one query per list |

Suggested client flow: multi-select → one `POST /api/sessions/:id/picks` with several `photo` parts; render
`photos[]` as a strip with per-photo status; poll `GET /api/picks/:id` while `analysisStatus === "pending"`; show the
per-photo retry button on `photos[i].analysisStatus === "failed"`; "Add photo" → `POST /api/picks/:id/photos`;
disable adding when `photos.length >= 6`.

## Server behaviour

- **Schema** (`server/db.ts`, idempotent DDL): new table `pick_photos (id, pick_id → picks ON DELETE CASCADE, path,
  position, analysis_status default 'pending', analysis_error, items jsonb, palette jsonb, summary, analyzed_at,
  created_at)` with indexes on `(pick_id, position)` and `analysis_status`. The `picks` row keeps `photo_path` (= cover),
  `items`/`palette`/`analysis_status`/`analysis_error`/`analyzed_at` as **stored aggregates**.
- **Migration on boot** (`migratePickPhotos`): every pick without a `pick_photos` row gets one from `picks.photo_path`
  (position 0) carrying the pick's status, error, items, palette, analyzed_at and created_at. Done row by row in JS so a
  malformed legacy JSON string becomes `[]` instead of aborting the boot; logs `[db] pick_photos: back-filled N legacy pick(s)`.
- **Aggregation** (`server/aggregate.ts`, pure): used both by `storage.recomputePickAggregates` (persisted) and by
  `storage.pickView` (recomputed from the photo rows on every read, so the API can never show a stale aggregate). A
  pick without photo rows (back-fill not run yet) falls back to its own columns.
- **Analysis queue** (`server/analysis.ts`): job key is now the **photo id**; dedupe/parking are per photo; concurrency
  still `VISION_CONCURRENCY` (2) across all photos. Completion/failure writes the `pick_photos` row guarded by
  `WHERE id = ? AND path = ?` and recomputes the pick aggregates **in the same transaction** (`db.transaction`, works on
  pglite and postgres-js). Stale jobs (photo deleted or pick re-posted) find no row and are dropped. Boot recovery and
  the 10-minute sweep query `pick_photos` (`stalePendingPhotos`) and log `re-queued N pending photo(s)`.
- **Storage** (`server/storage.ts`): `upsertPick({ photoPaths[] })` creates pick + N photos in one transaction and
  returns `previousPhotoPaths` for cleanup; `addPhotos`, `deletePhoto` (renumber + recompute), `markPhotosPending`,
  `completePhotoAnalysis`, `failPhotoAnalysis`, `recomputePickAggregates`, `photosForPick(s)`, `getPhoto`;
  `deletePick` returns all paths to remove.
- **Routes** (`server/routes.ts`): `multer.array("photo", PICK_MAX_PHOTOS)`; `LIMIT_UNEXPECTED_FILE` → 400 "Up to 6 photos
  per pick", `LIMIT_FILE_SIZE` → 400. Files are stored only after all of them sniffed OK; a storage failure half-way
  removes what was written.
- **Vision prompt** (`server/vision.ts` SYSTEM): now states the photo is either a full outfit on a person **or a single
  garment/shoes/accessory laid flat, on a hanger, held up or product-style**; describe only what is visible, never
  invent missing pieces; single-piece shots return 1–2 items, full outfits 2–6; palette ignores hangers/bedding. JSON
  shape unchanged.
- **Gemini retry policy** (per the parent agent's request, same file): on **503** ("high demand") the loop now moves to the
  next model **immediately** (no pause, no retry); on **429** it keeps the single 1.5 s pause + retry of the same model.
  The thinkingConfig / `payloadNoThinking` 400-fallback and the unparseable-JSON fall-through are unchanged. Previously a
  burst of 503s stretched one analysis to ~56 s.
- `PICK_MAX_PHOTOS` env (default 6, clamped 1..12) applies to both the initial upload and later additions.

## Test results (local, 2026-10-01)

- `npx tsc --noEmit -p .` → **server/shared/tests clean**. The remaining errors are in `client/src/**` (being edited by the
  other agent at the same time: its local `PickPhotoView` in `client/src/lib/analysis.ts` has an optional `analysisStatus`
  and an `optimistic` flag that conflict with the shared type; `session.tsx` passes a `queryKey` prop). Not touched.
- `npm run dev` on :5000 + `python tests/smoke.py --no-feedback --json tests/smoke-local-run-2026-10-01-multi-photo.json`
  → **142/142** (no Gemini key here, so every photo settles to `failed` in ~1 s; the aggregate-rule, add/delete/retry,
  7-photo and 403 assertions all ran against the real server).
- `python tests/mock_api.py 5999` + smoke `--no-feedback` → **142/142** (mock updated to the new contract; it still has
  no `/api/feedback`, as before).
- `python tests/test_analysis_mock.py` → **93/93** (was 41). New: 3-file upload → 3 photos; the pick observed `pending`
  with 2 photos ready + 1 pending (concurrency 2) and never `ready` while a photo was pending; items merged in photo
  order with the duplicate white shoes dropped and the duplicate's `brandGuess` kept; palette merged; note falls back to
  the cover summary; add photo (201/403/401/404/400 no file/400 sniff/400 at 7 total/201 to exactly 6/400 for the 7th);
  7 files in one POST → 400; delete cover → renumbered, cover moved, aggregates recomputed, file gone (404 on
  `/uploads`); photo of another pick → 404; per-photo retry (200, 202 while pending, 403, 404) with a fake 500 → that
  photo `failed`, pick stays `ready`, previous items kept; pick-level retry re-queues only the failed photo (1 Gemini
  call) and all photos when none failed (5 calls); 2-photo pick with both failing → pick `failed` with the first photo's
  error; delete down to 1 → last delete 400; kill-and-restart recovery per photo; **legacy migration**: `pick_photos`
  rows deleted directly in pglite between restarts → next boot back-fills exactly 1 photo with the pick's items/status.
- `python tests/test_prices_mock.py` → **133/133**, `python tests/test_feedback_mock.py` → **109/109** (no regressions).

## Caveats

- Dedupe is heuristic (`server/aggregate.ts`): same normalised category (light singularisation + a few aliases:
  sneaker/trainer/runner → shoe, tee/tshirt → t shirt, tight → legging) **and** (RGB distance ≤ 60 **or** same colour
  name **or** searchQuery token-Jaccard ≥ 0.6). Two genuinely different black pairs of shoes in one pick would merge;
  "shoes" vs "sneakers" merge; "leggings" vs "bike shorts" do not.
- The real Gemini path (success and the new 503 policy) was again only exercised through the fake Gemini — there is no
  key in this sandbox. The fake returns 500 for failures; vision.ts treats 500 like 503/404 (next model), so the test
  behaviour matches the new policy.
- `picks.items/palette/analysis_*` are still written (aggregates) so direct SQL readers keep working, but the API view
  recomputes from `pick_photos` on every read; the two can only differ if a row was edited by hand.
- The upload rate limiter counts requests (20/h/user), not files; `POST /api/picks/:id/photos` shares it.
- Re-posting a pick deletes all its photos and reactions (unchanged semantics, now for N photos). Clients that want to
  "add" must use `POST /api/picks/:id/photos`, not re-post.
- `pick_photos.created_at` drives the recovery/sweep age, so a retry of an old photo that gets stuck is re-queued by the
  next sweep (≤ 10 min) — an improvement over the pick-level `created_at` used before.
- The old `tests/smoke-local-run-2026-10-01-async-picks.json` etc. are kept; the new runs are `*-multi-photo.json`.
