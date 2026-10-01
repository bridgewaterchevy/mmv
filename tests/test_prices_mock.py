#!/usr/bin/env python3
"""
Offline test for the price-lookup + affiliate layer (server/prices.ts, server/affiliate.ts).
No provider keys, no network: the provider HTTP call is stubbed through MOCK_PRICES_JSON
(a SerpApi-shaped body the module honours) and Gemini through MOCK_VISION_JSON.

    python tests/test_prices_mock.py            # from the repo root; needs node_modules + `requests`

Part 1 runs tests/prices_harness.ts (one Node process, throwaway pglite dir) and asserts:
  parsing (SerpApi + HasData shapes), price sort, seller+title dedupe, cap 6, memo hit,
  DB cache hit, in-flight dedupe, daily budget guard, stale-cache fallback on budget / 429,
  "no provider -> [] fast", wrapLink (Amazon tag, Sovrn redirect, google skipped), Amazon price masking.
Part 2 boots the real server on a spare port with the mocks + SOVRN_API_KEY/AMAZON_ASSOCIATES_TAG,
  creates a crew/day/pick and checks GET /api/picks/:id/prices end to end (200 shape, offers,
  wrapped links in both offers and item.links, Amazon masking, 403 for non-members, 401 unauth).
Exit code 0 only if everything passes.
"""
import json
import os
import random
import shutil
import socket
import string
import subprocess
import sys
import tempfile
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" - {detail}" if (detail and not cond) else ""))
    return cond


MOCK_SERPAPI = {
    "shopping_results": [
        {"title": 'Align High-Rise Pant 25"', "source": "lululemon", "price": "$98.00", "extracted_price": 98,
         "product_link": "https://www.google.com/shopping/product/1", "thumbnail": "https://t/1.webp"},
        {"title": "Align Pant Dupe", "source": "Amazon.com", "price": "$29.99", "extracted_price": 29.99,
         "link": "https://www.amazon.com/dp/B0X"},
        # exact duplicate (seller+title) of the first row -> dropped
        {"title": 'Align High-Rise Pant 25"', "source": "lululemon", "price": "$98.00", "extracted_price": 98,
         "product_link": "https://www.google.com/shopping/product/1b"},
        # no extracted_price -> parsed from the display string; most expensive -> falls off the cap of 6
        {"title": "Align Pant 25 Black", "source": "Nordstrom", "price": "$118", "product_link": "https://www.google.com/shopping/product/2"},
        # no link at all -> Google Shopping search fallback url
        {"title": "No link item", "source": "Target", "price": "$45.00", "extracted_price": 45},
        {"title": "X1", "source": "S1", "extracted_price": 50, "product_link": "https://www.google.com/shopping/product/3"},
        {"title": "X2", "source": "S2", "extracted_price": 51, "product_link": "https://www.google.com/shopping/product/4"},
        {"title": "X3", "source": "S3", "extracted_price": 52, "product_link": "https://www.google.com/shopping/product/5"},
        # untitled -> ignored
        {"title": "", "source": "S4", "extracted_price": 1},
    ]
}

MOCK_VISION = {
    "summary": "Black leggings with white shoes",
    "palette": ["#1C1E24", "#F0F0F0"],
    "items": [
        {"category": "leggings", "description": "black high-rise leggings", "colorName": "black", "colorHex": "#1C1E24",
         "brandGuess": "lululemon", "searchQuery": "lululemon align high rise legging black"},
        {"category": "shoes", "description": "white running shoes", "colorName": "white", "colorHex": "#F0F0F0",
         "brandGuess": None, "searchQuery": "white running shoes women"},
    ],
}


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# --------------------------------------------------------------------------- part 1: harness
def run_harness():
    print("Part 1: tests/prices_harness.ts")
    tmp = tempfile.mkdtemp(prefix="mmv-prices-")
    env = {**os.environ, "PGLITE_DIR": os.path.join(tmp, "pglite"), "MOCK_PRICES_JSON": json.dumps(MOCK_SERPAPI),
           "PRICE_LOOKUPS_PER_DAY": "8"}
    for k in ("SERPAPI_KEY", "HASDATA_API_KEY", "SOVRN_API_KEY", "AMAZON_ASSOCIATES_TAG", "DATABASE_URL", "SUPABASE_DB_PASSWORD"):
        env.pop(k, None)
    try:
        proc = subprocess.run(["npx", "tsx", "tests/prices_harness.ts"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        check("harness finished", False, "timeout")
        return
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if proc.returncode != 0:
        check("harness exit 0", False, (proc.stderr or proc.stdout)[-800:])
        return
    line = [l for l in proc.stdout.splitlines() if l.startswith("{")][-1]
    r = json.loads(line)

    p = r["parse"]
    check("parse: untitled row ignored (8 of 9 parsed)", p["rawCount"] == 8, p["rawCount"])
    check("parse: capped at 6 offers", p["finalCount"] == 6, p["finalCount"])
    check("parse: sorted by price ascending", p["prices"] == sorted(p["prices"]), p["prices"])
    check("parse: seller+title dedupe", p["sellers"].count("lululemon") == 1 and "Nordstrom" not in p["sellers"], p["sellers"])
    check("parse: prefers direct `link` over product_link", "https://www.amazon.com/dp/B0X" in p["urls"], p["urls"])
    check("parse: missing link -> google shopping search url", any("udm=28" in u for u in p["urls"]), p["urls"])
    check("parse: thumbnail carried through", "https://t/1.webp" in p["thumbnails"], p["thumbnails"])
    check("parse: source tagged serpapi", p["sources"] == ["serpapi"], p["sources"])
    h = r["hasdata"]
    check("parse: HasData shoppingResults (extractedPrice/source/thumbnail)",
          h[0]["price"] == 419 and h[0]["seller"] == "Walmart - Seller" and h[0]["source"] == "hasdata" and h[1]["price"] is None, h)

    check("lookup: first call hits provider, budget=1", r["lookup1"]["from"] == "provider" and r["lookup1"]["budget"] == 1, r["lookup1"])
    check("lookup: query normalised (lowercase/trim/collapse spaces)", r["lookup1"]["key"] == "lululemon align legging black", r["lookup1"]["key"])
    check("cache: same query -> in-process memo, no provider call", r["lookup2"]["from"] == "memo" and r["lookup2"]["budget"] == 1, r["lookup2"])
    check("cache: fresh process -> DB cache hit, no provider call", r["lookup3"]["from"] == "db" and r["lookup3"]["budget"] == 1, r["lookup3"])
    check("cache: concurrent identical lookups share one provider call", r["concurrent"]["budget"] == 2, r["concurrent"])
    check("budget: spent -> new query returns [] without provider call", r["budget"]["from"] == "budget" and r["budget"]["count"] == 0 and r["budget"]["budget"] == 2, r["budget"])
    check("budget: cached query still served when budget spent", r["budgetCached"]["from"] == "db" and r["budgetCached"]["count"] == 6, r["budgetCached"])
    check("stale: expired cache served when budget spent", r["staleBudget"]["from"] == "stale" and r["staleBudget"]["count"] == 6, r["staleBudget"])
    check("stale: expired cache served when provider returns 429", r["staleQuota"]["from"] == "stale" and r["staleQuota"]["count"] == 6 and "run out" in (r["staleQuota"]["error"] or ""), r["staleQuota"])
    check("fail: provider 429 + no cache -> []", r["failNoCache"]["from"] == "none" and r["failNoCache"]["count"] == 0, r["failNoCache"])
    check("no provider configured -> [] quickly, budget untouched", r["noProvider"]["count"] == 0 and r["noProvider"]["ms"] < 500 and r["noProvider"]["budgetDelta"] == 0, r["noProvider"])

    w = r["wrap"]
    check("wrapLink: unchanged when no keys", w["unchangedNoKeys"] == ["https://www.amazon.com/dp/B0ABC?tag=old-20&ref=x", "https://shop.lululemon.com/p/leggings/Align-Pant?color=black"], w["unchangedNoKeys"])
    check("wrapLink: amazon tag replaced", w["amazon"] == "https://www.amazon.com/dp/B0ABC?tag=mmv-20&ref=x", w["amazon"])
    check("wrapLink: amazon.co.uk tag added", w["amazonUk"].endswith("tag=mmv-21"), w["amazonUk"])
    check("wrapLink: amazon not sent through Sovrn", w["amazonOnlySovrn"].startswith("https://www.amazon.com/"), w["amazonOnlySovrn"])
    sovrn_ok = w["retailer"].startswith("https://redirect.viglink.com?key=sovrn123&u=") and \
        urllib.parse.parse_qs(urllib.parse.urlparse(w["retailer"]).query)["u"][0] == "https://shop.lululemon.com/p/leggings/Align-Pant?color=black"
    check("wrapLink: retailer -> Sovrn redirect with encoded u=", sovrn_ok, w["retailer"])
    check("wrapLink: google.com search links untouched", w["google"] == "https://www.google.com/search?tbm=shop&q=leggings", w["google"])
    check("wrapLink: non-http input untouched", w["relative"] == "/not-a-url", w["relative"])
    check("wrapLink: idempotent (no double wrap)", w["doubleWrap"] == w["retailer"], w["doubleWrap"])
    check("isAmazonUrl: amazon.com / amzn.to yes, lululemon no", w["isAmazon"] == [True, False, True], w["isAmazon"])

    pr = r["present"]
    by_url = {o["url"].split("?")[0]: o for o in pr}
    am = by_url.get("https://www.amazon.com/dp/B01")
    gl = by_url.get("https://www.google.com/shopping/product/1")
    wm = by_url.get("https://redirect.viglink.com")
    check("presentOffers: amazon host -> price null + 'See price on Amazon' + tag", am and am["price"] is None and am["priceText"] == "See price on Amazon" and "tag=mmv-20" in am["url"], pr)
    check("presentOffers: seller 'Amazon…' masked even on google link", gl and gl["price"] is None and gl["priceText"] == "See price on Amazon", pr)
    check("presentOffers: other retailer keeps price, Sovrn-wrapped, listed first", wm and wm["price"] == 12 and pr[0] is wm, pr)


# --------------------------------------------------------------------------- part 2: server
def run_server_test():
    print("Part 2: GET /api/picks/:id/prices against a mocked server")
    try:
        import requests
    except ImportError:
        check("requests installed", False, "pip install requests")
        return
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    tmp = tempfile.mkdtemp(prefix="mmv-prices-srv-")
    env = {**os.environ, "PORT": str(port), "NODE_ENV": "development", "PGLITE_DIR": os.path.join(tmp, "pglite"),
           "MOCK_PRICES_JSON": json.dumps(MOCK_SERPAPI), "MOCK_VISION_JSON": json.dumps(MOCK_VISION),
           "SOVRN_API_KEY": "sovrn-test", "AMAZON_ASSOCIATES_TAG": "mmvtest-20", "PRICE_LOOKUPS_PER_DAY": "8"}
    for k in ("SERPAPI_KEY", "HASDATA_API_KEY", "DATABASE_URL", "SUPABASE_DB_PASSWORD", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY"):
        env.pop(k, None)
    # Dev mode (vite middleware) so no client build is needed; the DB is a throwaway pglite dir and
    # the uploaded photo is deleted at the end (local ./uploads store).
    cwd = ROOT
    log = open(os.path.join(tmp, "server.log"), "w")
    proc = subprocess.Popen(["npx", "tsx", "server/index.ts"], cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(120):
            try:
                if requests.get(base + "/api/health", timeout=2).status_code == 200:
                    break
            except requests.RequestException:
                pass
            if proc.poll() is not None:
                break
            time.sleep(0.5)
        else:
            check("server booted", False, "timeout")
            return
        if proc.poll() is not None:
            log.flush()
            check("server booted", False, open(os.path.join(tmp, "server.log")).read()[-800:])
            return

        def api(method, path, token=None, **kw):
            headers = kw.pop("headers", {})
            if token:
                headers["x-auth-token"] = token
            return requests.request(method, base + path, headers=headers, timeout=30, **kw)

        rnd = lambda p: p + "".join(random.choices(string.ascii_lowercase, k=8))  # noqa: E731
        tok_a = api("POST", "/api/auth/signup", json={"name": "A", "handle": rnd("pa_"), "pin": "1234"}).json()["token"]
        tok_b = api("POST", "/api/auth/signup", json={"name": "B", "handle": rnd("pb_"), "pin": "1234"}).json()["token"]
        tok_c = api("POST", "/api/auth/signup", json={"name": "C", "handle": rnd("pc_"), "pin": "1234"}).json()["token"]
        crew = api("POST", "/api/crews", tok_a, json={"name": "Prices", "activity": "Gym"}).json()
        api("POST", "/api/crews/join", tok_b, json={"inviteCode": crew["inviteCode"]})
        sess = api("GET", f"/api/crews/{crew['id']}/day/2030-01-01", tok_a).json()
        jpeg = b"\xff\xd8\xff\xe0" + b"\x00" * 64
        up = api("POST", f"/api/sessions/{sess['id']}/picks", tok_a, files={"photo": ("o.jpg", jpeg, "image/jpeg")})
        pick = up.json()
        if not check("upload with MOCK_VISION_JSON -> 200 with 2 items", up.status_code == 200 and len(pick.get("items", [])) == 2, f"{up.status_code} {str(pick)[:200]}"):
            return
        links = pick["items"][0]["links"]
        amazon = [l for l in links if l["label"] == "Amazon"]
        brand = [l for l in links if l["label"].endswith("site")]
        compare = [l for l in links if l["label"] == "Compare prices"]
        check("pick view: Amazon link carries ?tag=", bool(amazon) and "tag=mmvtest-20" in amazon[0]["url"], links)
        check("pick view: brand-site link Sovrn-wrapped", bool(brand) and brand[0]["url"].startswith("https://redirect.viglink.com?key=sovrn-test&u="), links)
        check("pick view: google compare link untouched", bool(compare) and compare[0]["url"].startswith("https://www.google.com/"), links)

        r = api("GET", f"/api/picks/{pick['id']}/prices", tok_b)
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else None
        if not check("GET /api/picks/:id/prices (member B) -> 200 {items}", r.status_code == 200 and isinstance(body, dict) and isinstance(body.get("items"), list), f"{r.status_code} {str(body)[:200]}"):
            return
        items = body["items"]
        check("prices: one entry per item, carries category/searchQuery/links/offers", len(items) == 2 and all(k in items[0] for k in ("category", "searchQuery", "links", "offers")), [list(i.keys()) for i in items])
        offers = items[0]["offers"]
        priced = [o["price"] for o in offers if o["price"] is not None]
        check("prices: 6 offers, priced ascending then unpriced (masked Amazon) last",
              len(offers) == 6 and priced == sorted(priced) and all(o["price"] is None for o in offers[len(priced):]), [(o["seller"], o["price"]) for o in offers])
        am = [o for o in offers if o["seller"] == "Amazon.com"]
        check("prices: Amazon offer masked ('See price on Amazon', price null, tag added)", am and am[0]["price"] is None and am[0]["priceText"] == "See price on Amazon" and "tag=mmvtest-20" in am[0]["url"], am)
        others = [o for o in offers if o["seller"] != "Amazon.com"]
        check("prices: non-Amazon offers keep numeric price + priceText", all(isinstance(o["price"], (int, float)) and o["priceText"] for o in others), [(o["seller"], o["price"], o["priceText"]) for o in others])
        check("prices: google product links not Sovrn-wrapped (not a retailer)", all(o["url"].startswith("https://www.google.com/") for o in others), [o["url"] for o in others])
        check("prices: offers tagged source=serpapi", all(o["source"] == "serpapi" for o in offers))
        check("prices: item.links affiliate-wrapped in prices response too", any("tag=mmvtest-20" in l["url"] for l in items[0]["links"]))

        r2 = api("GET", f"/api/picks/{pick['id']}/prices", tok_a)
        check("prices: second call (cached) -> 200 identical offers", r2.status_code == 200 and r2.json()["items"][0]["offers"] == offers)
        check("prices: non-member -> 403", api("GET", f"/api/picks/{pick['id']}/prices", tok_c).status_code == 403)
        check("prices: no token -> 401", api("GET", f"/api/picks/{pick['id']}/prices").status_code == 401)
        check("prices: unknown pick -> 404", api("GET", "/api/picks/999999/prices", tok_a).status_code == 404)
        check("cleanup: DELETE pick -> 200", api("DELETE", f"/api/picks/{pick['id']}", tok_a).status_code == 200)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        if any(not ok for _, ok, _ in RESULTS):
            print("---- server.log tail ----")
            print(open(os.path.join(tmp, "server.log")).read()[-1500:])
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    run_harness()
    run_server_test()
    npass = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{npass}/{len(RESULTS)} checks passed")
    for name, ok, detail in RESULTS:
        if not ok:
            print(f"FAIL {name} -> {detail}")
    sys.exit(0 if npass == len(RESULTS) else 1)


if __name__ == "__main__":
    main()
