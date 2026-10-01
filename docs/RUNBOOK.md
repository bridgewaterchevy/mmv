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

- **No-tool export (small data):** Supabase dashboard → **Table Editor** → open each table (`users`, `crews`, `crew_members`, `sessions`, `picks`, `reactions`) → **…** menu → **Export as CSV**. Save the CSVs to iCloud Drive.
- **Full dump (ask Computer):** with the Supabase CLI installed, `supabase db dump --db-url "<DATABASE_URL>" -f mmv-backup.sql` produces a restorable SQL file. Store it somewhere private — it contains user data.

Photos live in **Storage → outfits** bucket and are *not* part of a database dump ([Supabase: Database Backups](https://supabase.com/docs/guides/platform/backups)); download the bucket from the Storage UI if you need a full copy.

## If the app is "down"

1. Open `https://<app>/api/health`. Slow first response (~1 min) is just a cold start ([Render](https://render.com/docs/free)).
2. Still failing → Render **Logs**. Database errors → check Supabase dashboard: a paused project shows a **Resume project** button ([Supabase: Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)).
3. GitHub → **Actions** → **keep-alive**: if runs are failing, the `APP_URL` variable is wrong; if the workflow is disabled (public repos after 60 days of no commits), click **Enable workflow** ([GitHub Docs](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)).
4. Render suspended the service for the month → free instance hours (750/month) are exhausted; it resumes on the 1st ([Render](https://render.com/docs/free)).

## Rotate a secret

Render → **mmv** → **Environment** → edit the value → save; Render redeploys. Secrets to rotate if leaked: `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API Keys → create a new secret key, then delete the old one), the database password (Supabase → Project Settings → Database → Reset database password, then update `DATABASE_URL`), and `GEMINI_API_KEY` (Google AI Studio → delete and create a key).
