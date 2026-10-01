# MMV — Match My Vibe

A small mobile-first web app for crews (friends, teams, classes) to coordinate what they're wearing: create a crew, add a day, post your outfit pick, see everyone else's, react. Sign-in is a handle plus a 4-digit PIN — no email required.

## Stack

- **Client:** React 18 + Vite 7, Tailwind CSS, shadcn/ui (Radix), TanStack Query — in `client/`
- **Server:** Node 20, Express 5, TypeScript (`tsx` in dev, esbuild bundle in prod) — in `server/`
- **Data:** Drizzle ORM. Postgres via Supabase in production (`DATABASE_URL`); embedded PGlite locally when unset. Schema in `shared/schema.ts`.
- **Files:** outfit photos in Supabase Storage (bucket `outfits`) when `SUPABASE_URL` is set, else `./uploads`
- **Vision:** Google Gemini for garment tagging (`GEMINI_API_KEY`, optional)

## Local development

```bash
npm install
cp .env.example .env     # all variables are optional for local dev
npm run dev              # http://localhost:5000
```

Other scripts: `npm run build` (→ `dist/index.cjs` + `dist/public`), `npm run start` (production), `npm run check` (tsc).

Health check: `GET /api/health` → `{"ok":true}`.

## Deploy

Free hosting on Render + Supabase, configured by `render.yaml`. Step-by-step instructions for a non-developer are in **[docs/DEPLOY.md](docs/DEPLOY.md)**; day-to-day operations (logs, redeploy, PIN reset, backups) are in **[docs/RUNBOOK.md](docs/RUNBOOK.md)**. A scheduled GitHub Action (`.github/workflows/keep-alive.yml`) keeps the free service awake.
