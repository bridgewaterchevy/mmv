# Shopping gender hints — backend handoff (2026-10-01)

Commit: `032f6ef` "Shopping queries: women's/men's hints from profile + vision fit guess"
(schema.ts / db.ts / vision.ts edits were swept into the concurrent keep-alive commits `fb848ee` / `464473d`; content is correct in HEAD).

## API shape (for the client)

### User / auth
- `PublicUser` now has `shopFor: "womens" | "mens" | "unisex" | null` (returned by signup, login, GET /api/me, crew members, pick.user).
- `POST /api/auth/signup` body: `{ name, handle, pin, shopFor? }` — `shopFor` optional, same values or `null`. Invalid value → 400 `{ message: "shopFor must be womens, mens or unisex" }`.
- **New** `PATCH /api/me` (requireAuth) body: `{ shopFor: "womens" | "mens" | "unisex" | null }` — key required (`{}` → 400), `null` clears. Returns the updated `PublicUser`.

### Garment items (pick.items[], GET /api/picks/:id/prices items[])
- `fit?: "womens" | "mens" | "unisex"` — vision's department guess (new picks only; old picks lack it → treated as unisex).
- `shoppingQuery?: string` — the query actually used for price lookups and the Compare prices / Amazon chips: `searchQuery` prefixed with `"women's "` / `"men's "`. Computed at read time, never stored. `searchQuery` is unchanged (raw vision output).
- `links[]` — "Compare prices" and "Amazon" URLs are rebuilt from `shoppingQuery` at read time (then affiliate-wrapped as before). Brand-site link is kept as stored.

### Hint rule (`buildShoppingQuery(item, owner)` in server/prices.ts)
1. pick OWNER's `shopFor` if `womens`/`mens` (not the viewer's);
2. else item `fit` if `womens`/`mens`;
3. else no prefix.
Never prefixes when the query already contains a department word (women/women's/womens/woman/men/men's/mens/man/ladies/lady/girl(s)/boy(s)/female/male/unisex, word-bounded, case-insensitive). `price_cache` keys on `normalizeQuery(finalQuery)`, so hinted vs un-hinted lookups are separate rows (confirmed by test).

## Files changed
- shared/schema.ts — `SHOP_FOR`, `ShopFor`, `users.shopFor` (`shop_for` text nullable), `GARMENT_FITS`/`GarmentFit`, `GarmentItem.fit?`, `GarmentItem.shoppingQuery?`.
- server/db.ts — `shop_for TEXT` in users DDL + `ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_for TEXT` (verified on existing local pglite DB).
- server/vision.ts — Gemini prompt asks for `fit` (womens/mens/unisex, default unisex, judged from garment not wearer; told not to put women's/men's in searchQuery); `normalizeFit()` coerces anything odd to unisex.
- server/prices.ts — `hasDepartmentWord`, `shoppingHint`, `buildShoppingQuery`, `applyShoppingHints` (read-time: sets shoppingQuery, rebuilds Compare prices/Amazon links).
- server/storage.ts — `createUser({shopFor})`, `updateUser(id, {shopFor})`, `pickView` applies `applyShoppingHints(items, owner)` before affiliate wrapping.
- server/routes.ts — signup accepts `shopFor`; `PATCH /api/me`; prices route looks up `item.shoppingQuery` (owner's hint).
- tests/prices_harness.ts, tests/test_prices_mock.py — +29 checks (buildShoppingQuery matrix, applyShoppingHints, signup/PATCH /api/me, hinted shoppingQuery in pick view + prices, profile-clear → fit fallback with fresh cache key).
- tests/smoke.py — signup with shopFor, PATCH /api/me (set/invalid/401/null/restore), shoppingQuery present + hinted on prices items.

## Results
- `npx tsc --noEmit -p .` → clean (exit 0).
- `python3 tests/test_prices_mock.py` → 126/126.
- `python3 tests/smoke.py --base http://127.0.0.1:5000` against `npm run dev` → 80/80 (vision analysisFailed=true locally: no Gemini key, expected). Results in tests/smoke-local-run-2026-10-01-shopfor.json. Dev server stopped afterwards; port 5000 free.
