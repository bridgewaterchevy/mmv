# Putting MMV on the internet — a step-by-step guide for Bryan (Mac)

This guide gets **MMV (Match My Vibe)** running at a public web address for **$0/month**.
You do it once; after that, updates go live automatically.

You will create three free accounts, in this order:

| Service | What it does for MMV | Cost |
|---|---|---|
| **GitHub** | Holds the app's code and runs a tiny "stay awake" timer | $0 |
| **Supabase** | The database (users, crews, picks) and the photo storage | $0 |
| **Render** | Runs the app server and gives you the `https://…onrender.com` address | $0 |

Plus one free API key from **Google AI Studio** so the app can recognise garments in photos.

Budget about 45 minutes. Use Safari or Chrome. Have the **Apple Passwords** app open — you will be saving several passwords and keys as you go.

---

## Before you start: what is secret and what is not

Some values you collect below are like house keys. Treat them this way:

| Value | Secret? | Where it goes |
|---|---|---|
| GitHub / Supabase / Render account passwords | **Yes** | Apple Passwords only |
| Supabase **database password** | **Yes** | Apple Passwords, then into Render (step 3) |
| Supabase **secret / service_role key** | **Yes** | Render only |
| **Gemini API key** | **Yes** | Render only |
| **DATABASE_URL** (contains the database password) | **Yes** | Render only |
| Supabase **Project URL** (`https://xxxx.supabase.co`) | No | Render; fine to share |
| Your Render app address (`https://mmv-xxxx.onrender.com`) | No | GitHub variable; fine to share |

**If you ever need to give a secret value to Computer (your AI assistant), use the secure credential form it offers — never paste a secret into the chat.** Supabase warns that a leaked secret key exposes all of your project's data ([Supabase API keys](https://supabase.com/docs/guides/api/api-keys)), and Render says never to hardcode secrets into the config file ([Render Blueprint spec](https://render.com/docs/blueprint-spec)).

---

## Step 1 — Create a free GitHub account

1. Go to <https://github.com/signup>.
2. Enter your email, choose a password (save it in Apple Passwords), pick a username (e.g. `bryan-mmv`).
3. Verify your email when GitHub asks. A free personal account with a verified email is all you need, and you can also sign up with your Google or Apple account ([GitHub Docs](https://docs.github.com/en/get-started/start-your-journey/creating-an-account-on-github)).
4. Create the repository that will hold MMV: click the **+** (top right) → **New repository** → name it `mmv` → choose **Public** → **Create repository**.

**Why Public?** GitHub Actions minutes are unlimited on public repositories; private repositories only get 2,000 minutes per month, and every run is rounded up to a full minute ([GitHub billing](https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions)). The "stay awake" timer in step 5 runs about 4,300 times a month, which would blow through a private repo's quota. Your code contains **no secrets** (they all live in Render), so public is safe.

> Getting the code into this repository is the one part that needs a developer tool. Ask Computer to push the MMV code to `github.com/<your-username>/mmv` on the `main` branch, or install [GitHub Desktop](https://desktop.github.com/) and use **File → Add Local Repository → Publish**.

---

## Step 2 — Create a free Supabase account and the `mmv` project

### 2a. Account and project

1. Go to <https://supabase.com/dashboard> and click **Sign in with GitHub** (easiest — you just made that account). Authorise it.
2. Click **New project**.
3. Fill in:
   - **Name:** `mmv`
   - **Database Password:** click **Generate a password**. **Immediately save it in Apple Passwords** under "Supabase mmv database password". You cannot see it again later (you can only reset it).
   - **Region:** choose **East US (North Virginia)** — the closest `us-east` option. (Render will be in Oregon or Ohio; either is fine for a hobby app.)
   - **Plan:** Free.
4. Click **Create new project** and wait a minute or two for it to finish setting up.

What the Free plan gives you, per the [Supabase pricing page](https://supabase.com/pricing): **500 MB database**, **1 GB file storage**, up to 2 active projects, and **projects are paused after 1 week of inactivity** (step 5 handles this).

### 2b. Copy the Project URL

1. Click **Connect** at the top of the project page.
2. Pick the **App Frameworks** tab. The **Project URL** looks like `https://abcdefghijkl.supabase.co`. (The Supabase docs point at this Connect dialog for the URL and keys — [Supabase API keys](https://supabase.com/docs/guides/api/api-keys).)
3. Copy it into a note — this is `SUPABASE_URL`. Not secret.

### 2c. Copy the secret key (this IS secret)

1. In the left sidebar click the gear **Project Settings**, then **API Keys**. Supabase's docs confirm every key lives here — "there is no separate Settings > API page" ([Supabase API keys](https://supabase.com/docs/guides/api/api-keys)).
2. You will see two kinds of keys:
   - **Publishable key** (`sb_publishable_…`) — not what we need.
   - **Secret key** (`sb_secret_…`) — **this one**. If none exists yet, click **Create new secret key**, name it `render`, and copy it. Click the eye/copy icon to reveal it.
   - There may also be a **Legacy API keys** tab with `anon` and `service_role` (very long, start with `eyJ`). The `service_role` key also works, but Supabase is retiring these legacy keys by the end of 2026, so prefer the `sb_secret_…` one ([Supabase API keys](https://supabase.com/docs/guides/api/api-keys)).
3. Save it in Apple Passwords as "Supabase mmv secret key". This is `SUPABASE_SERVICE_ROLE_KEY`. **Secret. Bypasses all security rules. Never put it in chat, email, or a web page.**

### 2d. Copy the database connection string (also secret)

1. Click **Connect** at the top of the page again.
2. Under the connection-string section choose **Transaction pooler**.
3. Copy the string. It looks like:
   `postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-1-us-east-1.pooler.supabase.com:6543/postgres`
   (Copy the real host from the dialog; it cannot be guessed — [Supabase: Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres).)
4. Replace `[YOUR-PASSWORD]` (including the square brackets) with the database password you saved in step 2a. If your password contains `@`, `#`, `/`, `?` or `%`, ask Computer to URL-encode it for you.
5. Save the completed string in Apple Passwords as "Supabase mmv DATABASE_URL". This is `DATABASE_URL`. **Secret.**

**Why the pooler on port 6543 and not the "Direct connection"?** The direct connection (port 5432, `db.…supabase.co`) is only reachable over IPv6 unless you pay for Supabase's IPv4 add-on, whereas the shared pooler is IPv4-only on every plan ([Supabase docs](https://supabase.com/docs/guides/database/connecting-to-postgres)). Render's free web services don't have IPv6 outbound, so the direct string simply won't connect from Render. MMV's server is already configured for transaction mode (it turns off prepared statements, which the transaction pooler does not support — [Supabase docs](https://supabase.com/docs/guides/database/connecting-to-postgres)). If you ever see connection errors mentioning "prepared statement", switch to the **Session pooler** string instead (same dialog, port 5432) — it is also IPv4-compatible.

---

## Step 3 — Create a free Render account and deploy with the Blueprint

1. Go to <https://render.com> → **Get Started** → **Sign in with GitHub**. Authorise Render to see your GitHub repositories (you can limit it to just `mmv`).
2. In the Render dashboard click **New +** → **Blueprint** ([Render Blueprints](https://render.com/docs/infrastructure-as-code)).
3. Find the `mmv` repository in the list and click **Connect**.
4. Give the Blueprint a name (`mmv`) and leave the branch as `main`. Render reads the `render.yaml` file in the repo and shows one web service called **mmv** on the **Free** plan.
5. Render now asks you for the four values it cannot read from the file (this prompt only appears during the first Blueprint deploy — [Render Blueprint spec](https://render.com/docs/blueprint-spec)):

   | Field | Paste |
   |---|---|
   | `DATABASE_URL` | the completed Transaction-pooler string from 2d |
   | `SUPABASE_URL` | the Project URL from 2b |
   | `SUPABASE_SERVICE_ROLE_KEY` | the secret key from 2c |
   | `GEMINI_API_KEY` | see step 4 — you can paste it now, or leave it empty and add it later |

6. Click **Apply** / **Deploy Blueprint**. The first build takes 3–6 minutes. When the service shows **Live**, you'll see your address at the top of the service page, e.g. `https://mmv.onrender.com` (Render adds a suffix like `mmv-ab12.onrender.com` if `mmv` is taken).

**No credit card is needed.** Render's free web service plan is $0; the trade-offs are listed at the end of this document.

---

## Step 4 — Gemini API key (for garment recognition)

1. Go to <https://aistudio.google.com/apikey> and sign in with a Google account. New users get a default project and API key created automatically after accepting the terms ([Google AI for Developers](https://ai.google.dev/gemini-api/docs/api-key)).
2. Click **Create API key** (or copy the existing one). Save it in Apple Passwords as "Gemini API key MMV". **Secret.**
3. In Render: open the **mmv** service → **Environment** tab → find `GEMINI_API_KEY` → **Edit** → paste → **Save, rebuild, and deploy**. (If you pasted it during step 3, you're done.)

Without this key the app still works; outfit photos just won't be auto-tagged.

---

## Step 5 — Tell GitHub your app address (keeps the app awake)

The repository already contains a tiny scheduled job (`.github/workflows/keep-alive.yml`) that visits `https://<your app>/api/health` every 10 minutes. It needs to know your address:

1. On GitHub open your `mmv` repository → **Settings** tab.
2. In the left sidebar under **Security**, click **Secrets and variables** → **Actions**.
3. Click the **Variables** tab → **New repository variable** ([GitHub Docs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables)).
4. **Name:** `APP_URL`  **Value:** your Render hostname **without** `https://`, e.g. `mmv.onrender.com`.
5. Click **Add variable**.
6. To test it: go to the **Actions** tab → **keep-alive** → **Run workflow**. A green check within a minute means it works.

Why this matters:

- Render spins a free service down after **15 minutes** without a visitor, and the next visitor waits about **a minute** while it wakes up ([Render: Deploy for Free](https://render.com/docs/free)). Pinging every 10 minutes keeps it warm during the day. Each free workspace gets **750 instance hours a month** — a single always-on service uses ~720–744, so one service fits, but a second free service would not ([Render: Deploy for Free](https://render.com/docs/free)).
- Supabase pauses a free project that has too little **database activity** over 7 days; "a few user requests to the database each day" is enough to prevent it ([Supabase: Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)). Real use of the app covers this; the weekly ping is only a backstop, and it only counts if `/api/health` actually runs a database query (ask Computer to make sure it does a `select 1`). If the project ever does pause, open the Supabase dashboard and click **Resume project** — data is kept for up to a year.
- GitHub's scheduler runs at most every 5 minutes and can be delayed during busy periods; on a public repo it is switched off automatically after 60 days with no commits, and you re-enable it from the Actions tab ([GitHub Docs](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)).

---

## Step 6 — Open it, check it, and (later) add your own domain

1. Open `https://<your app>.onrender.com` in Safari. First load after idle may take up to a minute (Render shows a loading page while it wakes).
2. Open `https://<your app>.onrender.com/api/health` — you should see `{"ok":true}`.
3. Sign up with a name, handle and 4-digit PIN, create a crew, upload a photo. If the upload succeeds, Supabase Storage is working; if garments are tagged, Gemini is working.
4. **Custom domain (optional, later):** in Render open the service → **Settings** → **Custom Domains** → **Add Custom Domain**, then add the DNS record Render shows you at your domain registrar. Render issues the HTTPS certificate automatically; the Hobby (free) workspace includes 2 custom domains ([Render: Custom Domains](https://render.com/docs/custom-domains)). The domain itself costs whatever your registrar charges (~$10–15/year) — that is the only possible cost in this whole setup.

---

## Cost and trade-offs, in one place

**Monthly cost: $0.** No card is required at GitHub, Supabase, Render or Google AI Studio for the free tiers used here.

| Trade-off | Detail | Source |
|---|---|---|
| Cold start | Free Render service spins down after 15 idle minutes; waking takes ~1 minute. The keep-alive job hides this most of the time. | [Render](https://render.com/docs/free) |
| 750 free instance hours / month | Enough for one always-on service; hours reset monthly and don't roll over. If exhausted, Render suspends free services until next month. | [Render](https://render.com/docs/free) |
| Ephemeral disk on Render | Anything saved to the server's own disk is lost on restart — that's why photos go to Supabase Storage, not Render. | [Render](https://render.com/docs/free) |
| Database 500 MB | Free Supabase database size. Plenty for thousands of users and picks. | [Supabase pricing](https://supabase.com/pricing) |
| Storage 1 GB | Free Supabase file storage — roughly 2,000–5,000 phone photos depending on size. | [Supabase pricing](https://supabase.com/pricing) |
| Project pausing | Free Supabase projects pause after 1 week of low activity; resume from the dashboard, data kept 1 year. | [Supabase](https://supabase.com/docs/guides/platform/free-project-pausing) |
| No automatic backups | Not included on Supabase Free — see `docs/RUNBOOK.md` for manual backups. | [Supabase pricing](https://supabase.com/pricing) |
| Gemini free tier | Rate-limited; heavy use may need a paid Google Cloud project. | [Google AI for Developers](https://ai.google.dev/gemini-api/docs/billing) |

When you outgrow this: Render's smallest paid plan removes the spin-down and Supabase Pro ($25/mo) removes pausing and adds daily backups.
