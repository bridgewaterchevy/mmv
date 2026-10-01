# Async pick analysis — backend handoff (2026-10-01)

Commit: "Picks: instant post, background outfit analysis, retry". Files: `server/analysis.ts` (new), `server/routes.ts`,
`server/storage.ts`, `server/files.ts`, `server/db.ts`, `shared/schema.ts`, `tests/smoke.py`, `tests/mock_api.py`,
`tests/test_prices_mock.py`, `tests/test_analysis_mock.py` (new), `docs/RUNBOOK.md`.

## API shape for the client

### PickView — new fields (every place a pick is returned: upload, GET pick, session views, closet, reactions, lock)

| field | type | notes |
| --- | --- | --- |
| `analysisStatus` | `"pending" \| "ready" \| "failed"` | `pending` = queued/running, `items`/`palette` are `[]` (fresh upload) or the previous result (retry). Old rows read `ready`. |
| `analysisError` | `string \| null` | short, secret-free reason when `failed` (e.g. `"Gemini 429: quota exceeded"`, `"Analysis timed out"`), else `null` |
| `analyzedAt` | ISO string \| `null` | when the last analysis finished (ready or failed); `null` while pending on a fresh upload |
| `analysisFailed` | `boolean` | compatibility alias, `=== (analysisStatus === "failed")`. Now present on **all** pick payloads, not only the upload response. |

Types are exported from `@shared/schema`: `AnalysisStatus`, `ANALYSIS_STATUSES`, and `PickView` includes `analysisFailed`.

### Endpoints

| method/path | auth | response | notes |
| --- | --- | --- | --- |
| `POST /api/sessions/:id/picks` (multipart `photo`, optional `note`) | crew member | **201** `PickView` with `analysisStatus: "pending"`, `items: []`, `palette: []` | Was 200 and blocked 20–40 s. Now returns in ~20 ms. `note` is the user's text or `null`; when blank it is filled with the model's one-line summary once analysis is ready. Same 400/401/404/429 cases as before. `Cache-Control: no-store`. |
| `GET /api/picks/:id` | crew member of the pick's session | 200 `PickView` | Poll target. 401 no token, 403 not in the crew, 404 unknown. `Cache-Control: no-store`. |
| `POST /api/picks/:id/analyze` | **owner only** | 200 `PickView` with `analysisStatus: "pending"` (`analysisError` cleared, previous items kept until the new result lands) | Re-queues analysis of a `ready`/`failed` pick. 403 non-owner, 404 unknown, **202** + current view if it is already pending (no new job), **429** after 10 successful retries/hour/user. `Cache-Control: no-store`. |
| `GET /api/sessions/:id`, `GET /api/crews/:id/day/:date` | crew member | `SessionView` whose `picks[]` carry the fields above | now sent with `Cache-Control: no-store` |

Suggested client flow: after the 201, show the pick immediately with a "Reading the pieces…" state; poll `GET /api/picks/:id` every ~1.5–2 s (or refetch the session) while `analysisStatus === "pending"`, give up after ~90 s and show a retry button that calls `POST /api/picks/:id/analyze` (owner only) when `failed`. A re-post (new photo) of the same session re-uses the same pick id and resets the status to `pending`.

## Server behaviour

- Queue: in-process, concurrency `VISION_CONCURRENCY` (default 2), deduped per pick id; a request for a pick whose job is running is parked and started afterwards. Job errors are caught and recorded on the row; the HTTP handler never awaits Gemini.
- Stale-result guard: every job carries the `photoPath` it started for; `completeAnalysis`/`failAnalysis` update only `WHERE id = ? AND photo_path = ?`, so a slow analysis of an old photo can't overwrite a newer re-post.
- Timeout per Gemini call: `VISION_TIMEOUT_MS` (default 120 s) → `failed` with `"Analysis timed out"`.
- Startup recovery: `recoverStuckAnalyses()` re-queues `pending` picks whose `created_at` is older than `VISION_RECOVERY_AGE_MS` (default 2 min) and logs `[analysis] recovery: re-queued N …`; the photo is reloaded from the file store (`files.read`, new on both local and Supabase stores). A 10-minute sweep (`VISION_SWEEP=0` disables) repeats this for rows older than 10 min that nobody is working on.
- Downscale: `sharp` is **not** a dependency (checked `package.json`), so the server does not resize; the hook in `analysis.ts` only activates if `sharp` happens to be installed (`VISION_DOWNSCALE=0` turns it off). The client-side ~1280 px resize is what keeps payloads small.
- Schema/DDL: `picks.analysis_status TEXT NOT NULL DEFAULT 'ready'`, `analysis_error TEXT`, `analyzed_at TIMESTAMPTZ`, plus `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for existing databases and an index on `analysis_status`.
- `shortError()` scrubs URLs' query strings and anything that looks like `key=`/`token=`/API-key tokens, condenses Gemini bodies to `Gemini <status>: <message>`, caps at 200 chars.

## Test results (local, 2026-10-01)

- `npx tsc --noEmit -p .` → clean (client files included).
- `npm run dev` on :5000 + `python tests/smoke.py --no-feedback` → **108/108** (upload answered in 0.0 s with `pending`; no Gemini key locally so the analysis settled to `failed` in ~1 s and the failure/retry/403 assertions ran; results in `tests/smoke-local-run-2026-10-01-async-picks.json`).
- `python tests/mock_api.py 5999` + smoke → 108/108 (mock updated to the new contract and the previously missing `shopFor`/`prices` stubs).
- `python tests/test_analysis_mock.py` (new; fake slow Gemini on localhost through the `CUSTOM_CRED_*` hooks) → **41/41**: 201 in <2 s while Gemini sleeps, max 2 in flight during a 4-upload burst, stale-photo guard, 500 → `failed` + scrubbed error → owner retry → `ready`, 202 while pending, 11th retry → 429, kill-and-restart recovery re-queues exactly 1 and the new process makes the call.
- `python tests/test_prices_mock.py` → 133/133 (Part 2 now polls `GET /api/picks/:id` until `ready`). `python tests/test_feedback_mock.py` → 109/109.

## Caveats

- The real Gemini success path was only exercised through the fake Gemini (no key in this sandbox); the HTTP/JSON path in `vision.ts` is unchanged.
- The queue is per process. Render runs one instance, so this is fine; with several instances each would recover/sweep independently (the `photo_path` guard keeps writes consistent, but a pick could be analysed twice).
- `POST /api/sessions/:id/picks` now returns **201**, not 200 — any client code checking `status === 200` must use `res.ok`.
- On retry the previous `items` stay visible until the new result lands (deliberate, so the crew keeps seeing pieces). A fresh upload always starts from `[]`.
- Smoke test still burns 3 signups per run (10/h/IP limit unchanged).
