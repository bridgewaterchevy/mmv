# MMV launch checklist (friends-and-family test, Render Free + Supabase Free)

Tick every box in order. Setup details live in `docs/DEPLOY.md`; day-to-day fixes in `docs/RUNBOOK.md`.
`<app>` below means your Render hostname, e.g. `mmv.onrender.com`.

## 1. Pre-launch (the day before)

- [ ] **Env vars set on Render** (Dashboard → mmv → Environment): `DATABASE_URL` (Supabase *Transaction pooler*, port 6543, password filled in), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET=outfits`, `GEMINI_API_KEY`, `NODE_ENV=production`, `NODE_VERSION=20`. Optional: `GEMINI_MODEL` (comma-separated fallback list; default `gemini-3.8-flash,gemini-3.5-flash,gemini-flash-latest`).
- [ ] **GEMINI_API_KEY works**: Render → Logs after the latest deploy shows no `vision failed` lines; a test upload returns `analysisFailed: false` (the smoke test prints `>> VISION: WORKED`).
- [ ] **Health endpoint green**: `curl -s https://<app>/api/health` → `{"ok":true}`; Render shows the service as *Live* with health check `/api/health`.
- [ ] **Supabase bucket exists and is public-read**: Supabase → Storage → bucket `outfits` shows the **Public** badge. Open a stored photo URL (`https://<ref>.supabase.co/storage/v1/object/public/outfits/...`) in a private browser window – it must load without a token.
- [ ] **Keep-alive workflow enabled**: GitHub repo → Settings → Secrets and variables → Actions → Variables → `APP_URL=<app>` (no `https://`). Actions tab → **keep-alive** → *Run workflow* → green check. Confirm the schedule is not disabled (public repos auto-disable after 60 idle days).
- [ ] **Smoke test green against the Render URL**:
  `pip install requests pillow && python tests/smoke.py --base https://<app>` → `N/N checks passed`, exit code 0. Re-run after any redeploy. (Signups are limited to 10/hour per IP – do not run it more than ~5 times an hour from one network.)
- [ ] **Branch protection / auto-deploy**: `autoDeployTrigger: commit` is on, so every push to `main` redeploys. Only push what you have smoke-tested locally.

## 2. Launch day (first two testers)

1. Send each tester the link `https://<app>` and these steps (iPhone):
   **Safari → open the link → Share button → "Add to Home Screen" → Add.** Open it from the Home Screen icon, not from Safari, so it runs full-screen. (Android: Chrome → ⋮ → *Add to Home screen*.) First load may take ~1 minute if the free service was asleep – tell them to wait, not refresh.
2. **Tester A**: Sign up (name, handle = letters/numbers/underscore, 4-digit PIN). Tap **New crew** → *Start a crew* tab → name + activity (e.g. *Gym*) → **Create crew**. A toast shows the 6-character **invite code** (also shown on the crew page). Screenshot or text the code to Tester B.
3. **Tester B**: Sign up → **New crew** → *Join a crew* tab → type the invite code → should land in the same crew with 2 members.
4. Both: open **today**, set a vibe (e.g. *all black*), take/upload an outfit photo, react to each other's pick with an emoji. Lock a pick.
5. You: watch Render → Logs live during this; every upload should log without `vision failed`. Confirm two objects appeared in Supabase → Storage → `outfits`.
6. Tell testers: PINs lock for 15 minutes after 6 wrong tries; you can reset a PIN (see `docs/RUNBOOK.md`).

## 3. Week one – what to watch

| Watch | Where | Threshold / action |
|---|---|---|
| `vision failed` in logs | Render → Logs (search `vision failed`) | Any entry: read the next line. `429` = Gemini quota (below); `400/404` = model name gone, change `GEMINI_MODEL`; `401/403` = key revoked. Picks still save, just without items/palette. |
| **Gemini free-tier quota** | Google AI Studio → *Rate limits* page for your project | Google no longer prints per-model free-tier numbers in its docs; the [rate-limits page](https://ai.google.dev/gemini-api/docs/rate-limits) says limits are RPM/TPM/RPD, **per project, RPD resets at midnight Pacific**, and the active numbers are shown in AI Studio. [Pricing page](https://ai.google.dev/gemini-api/docs/pricing) confirms `gemini-3.8-flash`, `3.7`, `3.6`, `3.5-flash` and `3.5-flash-lite` are free of charge on the free tier. Numbers seen in AI Studio in Sept 2026: **~20 requests/day for each 3.x Flash model** and **500/day for Flash-Lite** ([ScriptByAI, Sept 2026](https://www.scriptbyai.com/gemini-api-free-tier-limits/); [Google AI forum, 3 Sept 2026](https://discuss.ai.google.dev/t/gemini-3-8-flash-free-tier-20-rpd-is-too-limited-for-practical-evaluation/180609)). The default fallback chain (3.8 → 3.5 → flash-latest) gives roughly 3 × 20 uploads/day for the whole crew. If testers hit it, set `GEMINI_MODEL=gemini-3.8-flash,gemini-3.5-flash-lite` (500 RPD) or enable billing (Tier 1). |
| Upload success rate | Smoke test daily: `python tests/smoke.py --base https://<app>` | Any FAIL row → `docs/RUNBOOK.md`. |
| Supabase Storage usage | Supabase → Settings → Usage (Storage) | Free plan = 1 GB files, 500 MB DB. Phone photos are 2-5 MB; ~300 photos fills it. Deleting a pick removes its object. |
| Supabase project pause | Supabase dashboard banner | Free projects pause after 7 idle days; the weekly keep-alive ping prevents this. If paused: *Restore project*, then redeploy Render. |
| Render instance hours | Render → Billing | 750 free hours/month; one always-on service uses ~730. Do **not** add a second free service. |
| Cold starts / 502s | Render → Events; GitHub → Actions → keep-alive | Red keep-alive runs or repeated `Deploy live → Spun down` events mean the pinger is off. |
| Rate-limit complaints | Testers | Login: 6 wrong PINs/15 min per handle. Uploads: 20/hour per user. Signups: 10/hour per IP (a whole household shares one IP). |

**Rollback**: Render → Deploys → previous successful deploy → *Rollback*. Data lives in Supabase, so a rollback never loses picks.
