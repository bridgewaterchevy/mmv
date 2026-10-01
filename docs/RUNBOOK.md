# MMV runbook (day-to-day operations)

Short answers to "how do I…" once the app is live. Setup lives in [DEPLOY.md](./DEPLOY.md).

## Redeploy (ship a change)

Push to the `main` branch on GitHub. The Blueprint sets `autoDeployTrigger: commit`, so Render builds and deploys every commit on the linked branch automatically ([Render Blueprint spec](https://render.com/docs/blueprint-spec)). Progress shows under the service's **Events** tab; the build takes 3–6 minutes and the old version keeps serving until the new one passes `/api/health`.

Manual redeploy (e.g. after changing an environment variable): Render dashboard → **mmv** service → **Manual Deploy** → **Deploy latest commit**. Free services can roll back only to the two most recent previous deploys ([Render: Deploy for Free](https://render.com/docs/free)).

## Logs

Render dashboard → **mmv** → **Logs** tab. You can text-search and filter by level/time; each line shows level, timestamp and instance ([Render: Logs](https://render.com/docs/logging)). The app logs every `/api/*` request as `METHOD path status in Nms` (auth responses are redacted). Deploy/build output is separate: **Events** → click a deploy.

## Reset a user's PIN

PINs are stored as salted scrypt hashes, so you cannot type a new PIN straight into the table — you set a known hash instead.

1. Supabase dashboard → **mmv** project → **SQL Editor** (left sidebar) → **New query**.
2. Paste, replacing `theirhandle` with the user's handle (lowercase):

   ```sql
   -- Sets the PIN to 0000 (hash generated with the app's hashPin(); verified)
   update users
   set pin = 'scrypt$420b19618fa39c90b3f54b096d8975fb$a67ac0969d01532893e3bf76f7e191ca80a57b495e8ab397eeee2c1290007ce8'
   where handle = 'theirhandle';
   ```

3. Click **Run**. Tell the user to log in with PIN **0000**.

To set a PIN other than 0000, generate the hash on a machine with Node installed:

```bash
node -e 'const {randomBytes,scryptSync}=require("crypto");const s=randomBytes(16).toString("hex");console.log(`scrypt$${s}$${scryptSync(process.argv[1],s,32).toString("hex")}`)' 1234
```

and use that output as the `pin` value. (Alternative without SQL: **Table Editor** → `users` → find the row → double-click the `pin` cell → paste the hash → save.)

There is currently no in-app "change PIN" screen, so the user keeps 0000 until you reset it again or that feature is added.

## Back up the database

Supabase's automatic daily backups (Database → Backups) are **not included on the Free plan**; they start on Pro ([Supabase pricing](https://supabase.com/pricing)). Supabase recommends free projects export data regularly with the CLI's `db dump` ([Supabase: Database Backups](https://supabase.com/docs/guides/platform/backups)).

Cheapest options, pick one:

- **No-tool export (small data):** Supabase dashboard → **Table Editor** → open each table (`users`, `crews`, `crew_members`, `sessions`, `picks`, `reactions`, `feedback`) → **…** menu → **Export as CSV**. Save the CSVs to iCloud Drive.
- **Full dump (ask Computer):** with the Supabase CLI installed, `supabase db dump --db-url "<DATABASE_URL>" -f mmv-backup.sql` produces a restorable SQL file. Store it somewhere private — it contains user data.

Photos live in **Storage → outfits** bucket and are *not* part of a database dump ([Supabase: Database Backups](https://supabase.com/docs/guides/platform/backups)); download the bucket from the Storage UI if you need a full copy.

## If the app is "down"

1. Open `https://<app>/api/health`. Slow first response (~1 min) is just a cold start ([Render](https://render.com/docs/free)).
2. Still failing → Render **Logs**. Database errors → check Supabase dashboard: a paused project shows a **Resume project** button ([Supabase: Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)).
3. GitHub → **Actions** → **keep-alive**: if runs are failing, the `APP_URL` variable is wrong; if the workflow is disabled (public repos after 60 days of no commits), click **Enable workflow** ([GitHub Docs](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)).
4. Render suspended the service for the month → free instance hours (750/month) are exhausted; it resumes on the 1st ([Render](https://render.com/docs/free)).

## "Report a problem" / "Suggest an idea" (user feedback → GitHub issues)

Signed-in users can send a report (message, page, device, last error, optional screenshot). Each one has a `kind`: `problem` (default, a bug report) or `suggestion` (an idea). Every report is saved in the `feedback` table first; if GitHub filing is configured, an issue is opened as well and its URL is stored on the row. A GitHub outage never blocks a report — it just logs `[github] could not file issue …` in Render **Logs**.

### Set up the GitHub token (one time)

1. On github.com → profile picture → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token** (or open <https://github.com/settings/personal-access-tokens/new>).
2. Name it `MMV report-a-problem`, pick an expiry (max 1 year; set a calendar reminder), **Repository access** → *Only select repositories* → `bridgewaterchevy/mmv`.
3. **Repository permissions** → **Issues: Read and write**. Leave every other permission at *No access*. (Issues write implicitly grants *Metadata: Read-only*; that is expected.)
4. **Generate token**, copy the `github_pat_…` value once.
5. Render → **mmv** → **Environment** → set `GITHUB_ISSUES_TOKEN` to the token and `GITHUB_ISSUES_REPO` to `bridgewaterchevy/mmv` → **Save** (Render redeploys). The token is only ever sent as `Authorization: Bearer` to `api.github.com`; it is never logged.
6. Optional: create the `user-report` and `suggestion` labels in the repo (**Issues** → **Labels**). If a label cannot be applied, the server retries without labels, so this is cosmetic.

Issues carry the message, reporter (name, @handle, user id), page, device/user agent, app version, screenshot link (when publicly reachable — Supabase bucket URLs always are; set `APP_URL` so local `/uploads/...` paths become absolute too) and timestamp. Per kind:

| kind | Title | Label | First heading | "Last error" section |
| --- | --- | --- | --- | --- |
| `problem` | `[Report] <first 60 chars>` | `user-report` | What happened | always (code block or `_none captured_`) |
| `suggestion` | `[Idea] <first 60 chars>` | `suggestion` | The idea | only when a client error was captured |

Filter in GitHub with `label:user-report` or `label:suggestion`.

### Admins (who can read and resolve reports)

Set `ADMIN_HANDLES` on Render to a comma-separated list of **app handles** (the handle users sign in with, case-insensitive), e.g. `ADMIN_HANDLES=jane,bridgewaterchevy`. `GET /api/me` returns `isAdmin: true` for those users so the client can show the admin list.

| Endpoint | Who | What |
| --- | --- | --- |
| `POST /api/feedback` | any signed-in user | JSON `{ kind?, message, page?, userAgent?, appVersion?, lastError? }` or multipart with the same fields plus an optional `screenshot` image (≤ 5 MB). `kind` is `"problem"` (default) or `"suggestion"`; anything else is 400. Returns `{ id, kind, githubIssueUrl \| null }`. Limits are shared across kinds: 5/hour per user, 20/hour per IP (429). |
| `GET /api/feedback` | admin | Latest 100 reports, newest first, each with `kind`, `user: { id, name, handle }`, `status`, `githubIssueUrl`, `screenshotPath`. Optional `?kind=problem` / `?kind=suggestion` filter (other values 400). Non-admins get 403. |
| `PATCH /api/feedback/:id` | admin | Body `{ "status": "open" \| "resolved" }`. Returns the updated report. |

Quick check from a terminal (replace the token with the value the app stores in `localStorage` after login, header `x-auth-token`):

```bash
curl -H "x-auth-token: $TOKEN" https://<app>/api/feedback | jq '.[0]'
curl -H "x-auth-token: $TOKEN" "https://<app>/api/feedback?kind=suggestion" | jq 'map(.message)'
curl -X PATCH -H "x-auth-token: $TOKEN" -H "content-type: application/json" -d '{"status":"resolved"}' https://<app>/api/feedback/12
```

Screenshots live in the same Supabase bucket as outfit photos under `feedback/<id>.<ext>` (locally `./uploads/feedback/`). Delete them from **Storage → outfits** when you purge a report.

### If issues stop appearing

- Render **Logs** → search `[github]`. `HTTP 401 Bad credentials` = token expired or revoked → generate a new one and update `GITHUB_ISSUES_TOKEN`. `HTTP 404 Not Found` = token has no access to `GITHUB_ISSUES_REPO` (wrong repo in *Repository access*, or the Issues permission is missing). `HTTP 403 … rate limit` = wait an hour.
- Reports are still in the database either way: Supabase → **Table Editor** → `feedback` (or `GET /api/feedback` as an admin).
- Existing deployments get the `kind` column automatically at boot (`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS kind … DEFAULT 'problem'`); older rows read as `problem`.

## Outfit analysis runs in the background (picks)

Posting a pick no longer waits for Gemini. `POST /api/sessions/:id/picks` stores the photo and answers `201` right away with `analysisStatus: "pending"`; a small in-process queue (`server/analysis.ts`, at most `VISION_CONCURRENCY` = 2 Gemini calls at a time) fills in `items`/`palette` afterwards and the app polls `GET /api/picks/:id` until the status is `ready` or `failed`. Old rows (analysed inline at upload) read as `ready`.

What you will see in Render **Logs**:

| Line | Meaning |
| --- | --- |
| `[analysis] pick 42 photo 87 ready: 3 item(s) in 18342ms (upload)` | normal; one line per PHOTO (a pick can have up to 6); the word in brackets is the trigger (`upload`, `retry`, `recovery`, `sweep`) |
| `[analysis] pick 42 photo 87 failed after 1203ms (upload): Gemini 429: …` | vision errored for that photo; the short reason is stored on the photo and, when no photo of the pick succeeded, on the pick (`analysisError`). The owner can retry the pick (`POST /api/picks/:id/analyze`, re-runs the failed photos) or one photo (`POST /api/picks/:id/photos/:photoId/analyze`); 10 retries per hour per user |
| `[analysis] recovery: re-queued N pending photo(s) older than 120s` | printed once per boot; photos a previous process left `pending` are re-run (reloaded from storage) |
| `[analysis] pick 42 photo 87: path changed before analysis started; skipping stale job` | the photo was removed/replaced while a job was queued; harmless |
| `[db] pick_photos: back-filled N legacy pick(s)` | one-time migration: picks created before multi-photo support get their single photo copied into `pick_photos` |

Knobs (environment variables, all optional): `PICK_MAX_PHOTOS` (photos per pick, default 6, max 12), `VISION_CONCURRENCY` (default 2), `VISION_TIMEOUT_MS` (per Gemini call, default 120000), `VISION_RECOVERY_AGE_MS` (boot recovery threshold, default 120000), `VISION_SWEEP=0` disables the 10-minute safety sweep, `VISION_DOWNSCALE=0` skips the optional server-side resize (only active if the `sharp` package is installed — it is not by default; the app resizes photos to ~1280 px before upload).

If many picks sit in `pending` for minutes: the server is probably not running jobs (look for the recovery line after a restart) or Gemini is slow; `failed` picks with `Gemini 403/400` mean the key is missing or invalid (`GEMINI_API_KEY` on Render), `Gemini 429` means quota. Nothing is lost either way — the photo is stored and the crew sees it immediately; only the shopping pieces wait.

## Rotate a secret

Render → **mmv** → **Environment** → edit the value → save; Render redeploys. Secrets to rotate if leaked: `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API Keys → create a new secret key, then delete the old one), the database password (Supabase → Project Settings → Database → Reset database password, then update `DATABASE_URL`), `GEMINI_API_KEY` (Google AI Studio → delete and create a key), and `GITHUB_ISSUES_TOKEN` (GitHub → Settings → Developer settings → Fine-grained tokens → **Regenerate** or delete + create; see "Report a problem" above).
