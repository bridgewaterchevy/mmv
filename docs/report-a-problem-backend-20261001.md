# Report a problem — backend handoff (2026-10-01)

Commit `698a962` "Report a problem: feedback table, route, GitHub issue filing". Client files were not touched.

## Files changed

| File | Change |
| --- | --- |
| `shared/schema.ts` | `feedback` pgTable, `FEEDBACK_STATUSES`, types `Feedback`, `FeedbackReport`, `FeedbackCreated`, `FeedbackBody`, zod `feedbackBodySchema`, `feedbackStatusSchema`; `PublicUser` gains optional `isAdmin` |
| `server/db.ts` | `CREATE TABLE IF NOT EXISTS feedback` + two indexes (boot DDL) |
| `server/storage.ts` | `createFeedback`, `updateFeedback`, `getFeedback`, `countFeedbackSince`, `listFeedback(limit)` (joins reporter `{id,name,handle}`) |
| `server/files.ts` | `put(buffer, ext, mime, name?)` — optional fixed object key (`feedback/<id>.<ext>`, one folder level, upsert on Supabase, mkdir locally); local `remove` handles sub-folders safely |
| `server/github.ts` | **new** — `fileGithubIssue`, `issueTitle`, `issueBody`, `issueConfig`, `publicScreenshotUrl`; label retry; never throws; never logs the token; test hooks `MOCK_GITHUB_ISSUES_URL`, `MOCK_GITHUB_ISSUE_JSON` |
| `server/feedback.ts` | **new** — `registerFeedbackRoutes(app, {requireAuth, limited, sniffImage, ip})`, `isAdmin`, `adminHandles`; multer (5 MB, field `screenshot`) |
| `server/routes.ts` | imports/registers feedback routes; `GET /api/me` now returns `{...PublicUser, isAdmin}` |
| `render.yaml` | `GITHUB_ISSUES_TOKEN` (sync:false), `GITHUB_ISSUES_REPO=bridgewaterchevy/mmv`, `ADMIN_HANDLES` (sync:false) |
| `.env.example` | same three + optional `APP_URL` (makes local `/uploads/...` screenshots absolute in issues) |
| `docs/RUNBOOK.md` | "Report a problem" section: fine-grained PAT (Issues: Read and write on that repo only), admin endpoints table, troubleshooting, backup/rotation mentions |
| `tests/smoke.py` | feedback steps (+ `--no-feedback` flag) |
| `tests/test_feedback_mock.py`, `tests/feedback_harness.ts` | **new** offline tests with a local mock of api.github.com |

## API shape (for the client)

All routes need header `x-auth-token`.

### `POST /api/feedback`
- JSON body **or** `multipart/form-data` with the same field names plus optional file field `screenshot` (image, ≤ 5 MB, JPG/PNG/WebP/GIF/HEIC; magic bytes checked).
- Fields: `message` (required, 1–2000 chars after trim), `page`, `userAgent`, `appVersion`, `lastError` (≤ 4000) — all optional strings; `""` is treated as not provided. If `page`/`userAgent` are omitted the server falls back to the `Referer` / `User-Agent` headers.
- `200` → `{ id: number, githubIssueUrl: string | null }` (`null` when GitHub filing is not configured or failed — report is still saved).
- `400 { message }` validation / bad image / >5 MB ("Screenshot must be 5 MB or smaller"); `401`; `429 { message }` after 5 reports/user/hour (DB-counted) or 20/IP/hour.

### `GET /api/me`
- Unchanged fields + `isAdmin: boolean` (true when handle ∈ `ADMIN_HANDLES`). Use it to show/hide the admin list.

### `GET /api/feedback` (admin only → `403 { message: "Admins only" }` otherwise)
- `200` → `FeedbackReport[]`, newest first, max 100:
  ```ts
  { id, userId, message, page, userAgent, appVersion, lastError, screenshotPath, githubIssueUrl,
    status: "open" | "resolved", createdAt /* ISO string */, user: { id, name, handle } | null }
  ```
  `screenshotPath` is an absolute Supabase URL in prod or `/uploads/feedback/<id>.<ext>` locally (prefix with origin).

### `PATCH /api/feedback/:id` (admin only)
- Body `{ status: "open" | "resolved" }` → `200 FeedbackReport`; `400` bad status; `404` unknown id; `403` non-admin.

## Env vars
- `GITHUB_ISSUES_TOKEN` — fine-grained PAT, Repository access: only `bridgewaterchevy/mmv`, permission **Issues: Read and write**. Unset = no issues filed.
- `GITHUB_ISSUES_REPO` — default `bridgewaterchevy/mmv` (accepts a github.com URL too).
- `ADMIN_HANDLES` — comma-separated app handles, case-insensitive, `@` tolerated.
- `APP_URL` — optional public base URL; only affects screenshot links in issues for the local file store.
- Test hooks: `MOCK_GITHUB_ISSUES_URL`, `MOCK_GITHUB_ISSUE_JSON`.

## GitHub issue
Title `[Report] <first 60 chars>` (+ `…`), label `user-report` (retried once without labels on 404/422/5xx; not retried on 401/403). Body: message, reporter `Name @handle (user id N)`, page, device/user agent, app version, timestamp, feedback id, last error in a code block, screenshot (image link if public, otherwise "not publicly reachable").

## Results
- `npx tsc --noEmit -p .` — clean.
- `python3 tests/test_feedback_mock.py` — 81/81 (harness + real server with mock GitHub: body content, Bearer header, label retry, 500 non-blocking, 401 no retry, unreachable host, canned hook, sniff/size/validation 400s, 5/hour 429, admin 401/403/200, PATCH 400/404/200, token absent from logs).
- `python3 tests/smoke.py` against `npm run dev` on :5000 — 90/90 (`tests/smoke-local-run-2026-10-01-feedback.json`); server stopped afterwards.
- Note for prod smoke runs: each run files one real issue when the token is configured; use `--no-feedback` to skip.
