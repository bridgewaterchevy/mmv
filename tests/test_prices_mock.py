#!/usr/bin/env python3
"""
Offline test for the price-lookup + affiliate layer (server/prices.ts, server/affiliate.ts).
No provider keys, no network: the provider HTTP call is stubbed through MOCK_PRICES_JSON
(a SerpApi-shaped body the module honours) and Gemini through MOCK_VISION_JSON.

    python tests/test_prices_mock.py            # from the repo root; needs node_modules + `requests`

Part 1 runs tests/prices_harness.ts (one Node process, throwaway pglite dir) and asserts:
  parsing (SerpApi + HasData shapes), price sort, seller+title dedupe, cap 6, memo hit,
  DB cache hit, in-flight dedupe, daily budget guard, stale-cache fallback on budget / 429,
  "no provider -> [] fast", wrapLink (Amazon tag, Sovrn redirect, google skipped), Amazon price masking,
  direct retailer links: `link` preferred over product_link, Google ad-redirect (adurl=) unwrapping,
  direct/retailerHost fields, Immersive Product fallback (MOCK_IMMERSIVE_JSON) resolving only the
  cheapest non-direct offer, budget accounting (1 unit per resolve), resolved url cached in the same row
  (fresh-process read = zero provider calls), store choice by seller name / cheapest,
  buildShoppingQuery (women's/men's hint: profile shopFor overrides vision fit, unisex/null fall back to
  fit, existing women/men/ladies/girls words never doubled, no hint -> unchanged, cache keys differ),
  applyShoppingHints (Compare prices / Amazon links rebuilt from the hinted query, brand link kept).
Part 2 boots the real server on a spare port with the mocks + SOVRN_API_KEY/AMAZON_ASSOCIATES_TAG,
  creates a crew/day/pick and checks GET /api/picks/:id/prices end to end (200 shape, offers,
  wrapped links in both offers and item.links, Amazon masking, 403 for non-members, 401 unauth),
  plus signup { shopFor } / PATCH /api/me { shopFor } and the hinted shoppingQuery on pick items.
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
        # product_link only (google page) + immersive token -> non-direct; NOT the cheapest non-direct, so never resolved (limit 1)
        {"title": 'Align High-Rise Pant 25"', "source": "lululemon", "price": "$98.00", "extracted_price": 98,
         "product_link": "https://www.google.com/shopping/product/1", "thumbnail": "https://t/1.webp",
         "immersive_product_page_token": "tok-lulu",
         "serpapi_immersive_product_api": "https://serpapi.com/search.json?engine=google_immersive_product&page_token=tok-lulu"},
        # direct merchant `link` (direct_link=true) wins over product_link
        {"title": "Align Pant Dupe", "source": "Amazon.com", "price": "$29.99", "extracted_price": 29.99,
         "link": "https://www.amazon.com/dp/B0X", "product_link": "https://www.google.com/shopping/product/amz"},
        # exact duplicate (seller+title) of the first row -> dropped
        {"title": 'Align High-Rise Pant 25"', "source": "lululemon", "price": "$98.00", "extracted_price": 98,
         "product_link": "https://www.google.com/shopping/product/1b"},
        # no extracted_price -> parsed from the display string; most expensive -> falls off the cap of 6
        {"title": "Align Pant 25 Black", "source": "Nordstrom", "price": "$118", "product_link": "https://www.google.com/shopping/product/2"},
        # no link at all -> Google Shopping search fallback url; cheapest non-direct -> resolved via immersive (token only in the serpapi url)
        {"title": "No link item", "source": "Target", "price": "$45.00", "extracted_price": 45,
         "serpapi_immersive_product_api": "https://serpapi.com/search.json?engine=google_immersive_product&page_token=tok-target"},
        {"title": "X1", "source": "S1", "extracted_price": 50, "product_link": "https://www.google.com/shopping/product/3"},
        # Google ad-click redirect -> adurl extracted -> direct
        {"title": "X2", "source": "S2", "extracted_price": 51, "product_link": "https://www.google.com/shopping/product/4",
         "link": "https://www.google.com/aclk?sa=L&ai=DChc&adurl=https%3A%2F%2Fwww.s2shop.com%2Fp%2Fx2%3Fcolor%3Dblack"},
        {"title": "X3", "source": "S3", "extracted_price": 52, "product_link": "https://www.google.com/shopping/product/5"},
        # untitled -> ignored
        {"title": "", "source": "S4", "extracted_price": 1},
    ]
}

# Immersive Product API bodies keyed by page_token (https://serpapi.com/google-immersive-product-api)
MOCK_IMMERSIVE = {
    "tok-target": {"product_results": {"title": "No link item", "stores": [
        {"name": "Walmart", "link": "https://www.walmart.com/ip/other/2", "price": "$44.00", "extracted_price": 44},
        {"name": "Target", "link": "https://www.target.com/p/no-link-item/-/A-123", "price": "$45.00", "extracted_price": 45},
    ]}},
    "tok-lulu": {"product_results": {"title": "Align", "stores": [
        {"name": "Nordstrom", "link": "https://www.nordstrom.com/s/align/1", "price": "$98.00", "extracted_price": 98},
        {"name": "lululemon", "link": "https://shop.lululemon.com/p/womens-leggings/Align-Pant-25", "price": "$98.00", "extracted_price": 98},
        {"name": "Cheap Shop", "link": "https://cheap.example.com/align", "price": "$80.00", "extracted_price": 80},
        # a google.* store link is useless as a "direct" url -> ignored
        {"name": "Google Store", "link": "https://www.google.com/shopping/product/zzz", "price": "$1.00", "extracted_price": 1},
    ]}},
}

MOCK_VISION = {
    "summary": "Black leggings with white shoes",
    "palette": ["#1C1E24", "#F0F0F0"],
    "items": [
        {"category": "leggings", "description": "black high-rise leggings", "colorName": "black", "colorHex": "#1C1E24",
         "brandGuess": "lululemon", "searchQuery": "lululemon align high rise legging black", "fit": "womens"},
        # query already says "women" -> never prefixed, whatever the profile says
        {"category": "shoes", "description": "white running shoes", "colorName": "white", "colorHex": "#F0F0F0",
         "brandGuess": None, "searchQuery": "white running shoes women"},  # no fit -> treated as unisex
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
           "MOCK_IMMERSIVE_JSON": json.dumps(MOCK_IMMERSIVE), "PRICE_LOOKUPS_PER_DAY": "8"}
    env.pop("PRICE_DIRECT_RESOLVE_PER_ITEM", None)
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
    check("parse: Google ad redirect (aclk?adurl=) unwrapped to merchant url", "https://www.s2shop.com/p/x2?color=black" in p["urls"], p["urls"])
    # order after sort: Amazon 29.99 (direct), Target 45 (google search), S1 50, S2 51 (adurl direct), S3 52, lululemon 98
    check("parse: direct flag = url host not google.*", p["direct"] == [True, False, False, True, False, False], p["direct"])
    check("parse: retailerHost strips www., empty for google", p["hosts"] == ["amazon.com", "", "", "s2shop.com", "", ""], p["hosts"])
    check("parse: immersive token from field or from serpapi_immersive_product_api url", p["tokens"][1] == "tok-target" and p["tokens"][5] == "tok-lulu" and p["tokens"][2] is None, p["tokens"])
    check("defaults: PRICE_LOOKUPS_PER_DAY=12, PRICE_DIRECT_RESOLVE_PER_ITEM=1", r["defaults"] == {"budget": 12, "resolvePerItem": 1}, r["defaults"])
    a = r["adurl"]
    check("normalizeOfferUrl: google.com/aclk adurl= extracted (decoded)", a["aclk"] == "https://shop.lululemon.com/p/align?color=black&sz=6", a["aclk"])
    check("normalizeOfferUrl: googleadservices.com/pagead/aclk adurl= extracted", a["adservices"] == "https://www.nordstrom.com/s/123", a["adservices"])
    check("normalizeOfferUrl: retailer / google product page / aclk without adurl untouched",
          a["plain"] == "https://www.walmart.com/ip/1?x=1" and a["productPage"] == "https://www.google.com/shopping/product/1" and a["noAdurl"].startswith("https://www.google.com/aclk"), a)
    check("parse: HasData offers are direct:false with empty retailerHost (google search url)", r["hasdataDirect"] == [[False, "", True]], r["hasdataDirect"])
    h = r["hasdata"]
    check("parse: HasData shoppingResults (extractedPrice/source/thumbnail)",
          h[0]["price"] == 419 and h[0]["seller"] == "Walmart - Seller" and h[0]["source"] == "hasdata" and h[1]["price"] is None, h)

    l1 = r["lookup1"]
    check("lookup: first call hits provider + 1 immersive resolve, budget=2", l1["from"] == "provider" and l1["budget"] == 2 and l1["resolved"] == 1, {k: v for k, v in l1.items() if k != "offers"})
    by_seller = {o["seller"]: o for o in l1["offers"]}
    tgt, lulu, amz = by_seller.get("Target"), by_seller.get("lululemon"), by_seller.get("Amazon.com")
    check("resolve: cheapest non-direct offer (Target $45) resolved to the matching store's merchant url",
          tgt and tgt["url"] == "https://www.target.com/p/no-link-item/-/A-123" and tgt["direct"] is True and tgt["retailerHost"] == "target.com", tgt)
    check("resolve: pricier non-direct offer (lululemon $98) NOT resolved (limit 1), keeps google product_link",
          lulu and lulu["url"] == "https://www.google.com/shopping/product/1" and lulu["direct"] is False and lulu["token"] == "tok-lulu", lulu)
    check("resolve: offers with a direct `link` untouched", amz and amz["url"] == "https://www.amazon.com/dp/B0X" and amz["direct"] is True, amz)
    check("lookup: still 6 offers, cheapest first", l1["count"] == 6 and [o["price"] for o in l1["offers"]] == sorted(o["price"] for o in l1["offers"]), [o["price"] for o in l1["offers"]])
    check("lookup: query normalised (lowercase/trim/collapse spaces)", r["lookup1"]["key"] == "lululemon align legging black", r["lookup1"]["key"])
    check("cache: same query -> in-process memo, no provider call", r["lookup2"]["from"] == "memo" and r["lookup2"]["budget"] == 2, r["lookup2"])
    check("cache: fresh process -> DB cache hit, zero provider calls (budget still 2)", r["lookup3"]["from"] == "db" and r["lookup3"]["budget"] == 2, r["lookup3"])
    check("cache: resolved merchant url persisted in the price_cache row", "https://www.target.com/p/no-link-item/-/A-123" in r["lookup3"]["urls"] and r["lookup3"]["direct"].count(True) == 3, r["lookup3"])
    check("cache: concurrent identical lookups share one provider call (+1 resolve)", r["concurrent"]["budget"] == 4, r["concurrent"])
    check("budget: spent -> new query returns [] without provider call", r["budget"]["from"] == "budget" and r["budget"]["count"] == 0 and r["budget"]["budget"] == 4, r["budget"])
    check("budget: cached query still served when budget spent", r["budgetCached"]["from"] == "db" and r["budgetCached"]["count"] == 6, r["budgetCached"])
    check("stale: expired cache served when budget spent", r["staleBudget"]["from"] == "stale" and r["staleBudget"]["count"] == 6, r["staleBudget"])
    check("stale: expired cache served when provider returns 429", r["staleQuota"]["from"] == "stale" and r["staleQuota"]["count"] == 6 and "run out" in (r["staleQuota"]["error"] or ""), r["staleQuota"])
    check("fail: provider 429 + no cache -> []", r["failNoCache"]["from"] == "none" and r["failNoCache"]["count"] == 0, r["failNoCache"])
    check("no provider configured -> [] quickly, budget untouched", r["noProvider"]["count"] == 0 and r["noProvider"]["ms"] < 500 and r["noProvider"]["budgetDelta"] == 0, r["noProvider"])

    im = r["immersive"]
    check("immersive: stores parsed, google.* store links dropped", im["storeCount"] == 3 and all("google." not in u for u in im["links"]), im)
    check("immersive: store matching offer.seller preferred", im["bySeller"] == "https://shop.lululemon.com/p/womens-leggings/Align-Pant-25", im["bySeller"])
    check("immersive: seller 'Nordstrom - Seller' matches store 'Nordstrom'", im["bySellerSuffix"] == "https://www.nordstrom.com/s/align/1", im["bySellerSuffix"])
    check("immersive: unknown seller -> cheapest store", im["cheapestWhenUnknown"] == "https://cheap.example.com/align", im["cheapestWhenUnknown"])
    check("immersive: empty body -> no stores", im["emptyBody"] == 0)
    check("resolve: budget spent -> no call, google url kept (direct:false)", r["resolveNoBudget"] == {"calls": 0, "direct": False, "url": "https://www.google.com/shopping/product/1"}, r["resolveNoBudget"])
    rl = r["resolveLimit2"]
    by_title = {o["title"]: o for o in rl["offers"]}
    check("resolve: limit 2 -> exactly 2 calls charged to budget", rl["calls"] == 2 and rl["budgetDelta"] == 2, rl)
    check("resolve: cheapest two non-direct (B $45, A $98) resolved; C $120 left; direct D untouched",
          by_title["B"]["direct"] and by_title["B"]["host"] == "target.com" and by_title["A"]["direct"] and by_title["A"]["host"] == "shop.lululemon.com"
          and not by_title["C"]["direct"] and by_title["D"]["host"] == "walmart.com", rl["offers"])
    check("resolve: immersive 429 -> charged once, google url kept, no throw", r["resolveQuota"] == {"calls": 1, "direct": False}, r["resolveQuota"])
    check("sort: equal prices -> direct offer first", r["tieSort"] == ["d", "g"], r["tieSort"])

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
    check("presentOffers: direct/retailerHost computed before wrapping (walmart.com, not redirect.viglink.com)", wm and wm["direct"] is True and wm["retailerHost"] == "walmart.com", wm)
    check("presentOffers: google link -> direct:false, retailerHost ''", gl and gl["direct"] is False and gl["retailerHost"] == "", gl)
    check("presentOffers: immersiveToken never sent to the client", all(o["hasToken"] is False for o in pr), pr)

    sq = r["shopping"]
    check("buildShoppingQuery: profile womens -> \"women's \" prefix", sq["profileWomens"] == "women's royal blue athletic crewneck long sleeve", sq["profileWomens"])
    check("buildShoppingQuery: profile mens -> \"men's \" prefix", sq["profileMens"] == "men's royal blue athletic crewneck long sleeve", sq["profileMens"])
    check("buildShoppingQuery: profile overrides vision fit (mens profile, womens bra)", sq["profileOverridesFit"] == "men's black longline sports bra", sq["profileOverridesFit"])
    check("buildShoppingQuery: profile unisex falls back to fit", sq["profileUnisexFallsToFit"] == "women's black longline sports bra", sq["profileUnisexFallsToFit"])
    check("buildShoppingQuery: profile null falls back to fit (mens tee)", sq["profileNullFallsToFit"] == "men's grey boxy cotton tee", sq["profileNullFallsToFit"])
    check("buildShoppingQuery: no user object falls back to fit", sq["noUserFallsToFit"] == "women's black longline sports bra", sq["noUserFallsToFit"])
    check("buildShoppingQuery: unisex profile + unisex fit -> unchanged", sq["unisexBoth"] == "royal blue athletic crewneck long sleeve", sq["unisexBoth"])
    check("buildShoppingQuery: null profile + legacy item without fit -> unchanged", sq["nullAndLegacy"] == "black high rise leggings", sq["nullAndLegacy"])
    check("buildShoppingQuery: legacy item without fit still gets the profile hint", sq["legacyWithProfile"] == "women's black high rise leggings", sq["legacyWithProfile"])
    check("buildShoppingQuery: existing \"Women's\" not doubled", sq["alreadyWomens"] == "Women's Align leggings black", sq["alreadyWomens"])
    check("buildShoppingQuery: existing \"women\" (no apostrophe) blocks a men's prefix", sq["alreadyWomenNoApostrophe"] == "white running shoes women", sq["alreadyWomenNoApostrophe"])
    check("buildShoppingQuery: existing \"mens\" blocks a women's prefix", sq["alreadyMens"] == "mens nike dri-fit tee", sq["alreadyMens"])
    check("buildShoppingQuery: existing \"ladies\" / \"girls\" / \"unisex\" block the prefix",
          sq["alreadyLadies"] == "ladies golf skort navy" and sq["alreadyGirls"] == "girls pink leotard" and sq["alreadyUnisexWord"] == "unisex black hoodie",
          [sq["alreadyLadies"], sq["alreadyGirls"], sq["alreadyUnisexWord"]])
    check("buildShoppingQuery: 'men' inside 'garment' is not a department word", sq["garmentNotMen"] == "men's garment dyed crewneck", sq["garmentNotMen"])
    check("buildShoppingQuery: whitespace collapsed before prefixing", sq["whitespaceCollapsed"] == "women's royal blue crewneck", sq["whitespaceCollapsed"])
    check("buildShoppingQuery: empty searchQuery -> color + description, still hinted", sq["emptyFallsToColorDesc"] == "women's black leggings", sq["emptyFallsToColorDesc"])
    check("buildShoppingQuery: nothing to search -> ''", sq["empty"] == "", sq["empty"])
    check("shoppingHint: source profile / fit / none", sq["hintSources"] == ["profile", "fit", "none"], sq["hintSources"])
    check("hasDepartmentWord: women/women's/womens/men/men's/mens/ladies/girls/boys/female/male/unisex/woman/man yes, garment no",
          sq["departmentWords"] == [True] * 12 + [False, True, True], sq["departmentWords"])
    check("buildShoppingQuery: hinted queries normalise to distinct price_cache keys", sq["cacheKeysDiffer"] is True, sq["cacheKeysDiffer"])
    check("normalizeFit: womens/Women's/men/unisex/kids/undefined/null", sq["normalizeFit"] == ["womens", "womens", "mens", "unisex", "unisex", "unisex", "unisex"], sq["normalizeFit"])

    ah = r["applyHints"]
    check("applyShoppingHints: shoppingQuery set from profile", ah["mensQuery"] == "men's lululemon align legging black", ah["mensQuery"])
    links = dict(ah["mensLinks"])
    check("applyShoppingHints: Compare prices link rebuilt from hinted query", links.get("Compare prices") == "https://www.google.com/search?tbm=shop&q=men's%20lululemon%20align%20legging%20black", links)
    check("applyShoppingHints: Amazon link rebuilt from hinted query", links.get("Amazon") == "https://www.amazon.com/s?k=men's%20lululemon%20align%20legging%20black", links)
    check("applyShoppingHints: brand-site link kept as stored", links.get("lululemon site") == "https://shop.lululemon.com/search?Ntt=align%20legging%20black", links)
    check("applyShoppingHints: null profile -> fit hint (women's) in query + links", ah["fitQuery"] == "women's lululemon align legging black" and "women's%20" in (ah["fitCompare"] or ""), ah)
    check("applyShoppingHints: no hint -> shoppingQuery == searchQuery, links untouched", ah["noneQuery"] == "lululemon align legging black" and ah["noneLinksUnchanged"] is True, ah)
    check("applyShoppingHints: item without stored links gets a fresh set", ah["noLinksRebuilt"] == ["Compare prices", "Amazon", "lululemon site"], ah["noLinksRebuilt"])
    check("applyShoppingHints: pure (input not mutated) and idempotent", ah["storedUntouched"].endswith("q=lululemon%20align%20legging%20black") and ah["idempotent"] is True, ah)


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
           "MOCK_PRICES_JSON": json.dumps(MOCK_SERPAPI), "MOCK_IMMERSIVE_JSON": json.dumps(MOCK_IMMERSIVE), "MOCK_VISION_JSON": json.dumps(MOCK_VISION),
           "SOVRN_API_KEY": "sovrn-test", "AMAZON_ASSOCIATES_TAG": "mmvtest-20", "PRICE_LOOKUPS_PER_DAY": "20"}
    env.pop("PRICE_DIRECT_RESOLVE_PER_ITEM", None)
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
        # ---- signup accepts optional shopFor; PATCH /api/me updates it
        sa = api("POST", "/api/auth/signup", json={"name": "A", "handle": rnd("pa_"), "pin": "1234", "shopFor": "womens"})
        check("signup: { shopFor: 'womens' } accepted and echoed as user.shopFor", sa.status_code == 200 and sa.json()["user"].get("shopFor") == "womens", f"{sa.status_code} {sa.text[:200]}")
        tok_a = sa.json()["token"]
        sb = api("POST", "/api/auth/signup", json={"name": "B", "handle": rnd("pb_"), "pin": "1234"})
        check("signup: shopFor omitted -> user.shopFor null", sb.status_code == 200 and "shopFor" in sb.json()["user"] and sb.json()["user"]["shopFor"] is None, f"{sb.status_code} {sb.text[:200]}")
        tok_b = sb.json()["token"]
        tok_c = api("POST", "/api/auth/signup", json={"name": "C", "handle": rnd("pc_"), "pin": "1234"}).json()["token"]
        bad = api("POST", "/api/auth/signup", json={"name": "D", "handle": rnd("pd_"), "pin": "1234", "shopFor": "kids"})
        check("signup: invalid shopFor -> 400", bad.status_code == 400, f"{bad.status_code} {bad.text[:200]}")
        pm = api("PATCH", "/api/me", tok_a, json={"shopFor": "mens"})
        check("PATCH /api/me { shopFor: 'mens' } -> 200 PublicUser with shopFor=mens, no pin/token",
              pm.status_code == 200 and pm.json().get("shopFor") == "mens" and "pin" not in pm.json() and "token" not in pm.json(), f"{pm.status_code} {pm.text[:200]}")
        me = api("GET", "/api/me", tok_a)
        check("GET /api/me reflects shopFor=mens", me.status_code == 200 and me.json().get("shopFor") == "mens", me.text[:200])
        check("PATCH /api/me invalid value -> 400", api("PATCH", "/api/me", tok_a, json={"shopFor": "kids"}).status_code == 400)
        check("PATCH /api/me missing key -> 400", api("PATCH", "/api/me", tok_a, json={}).status_code == 400)
        check("PATCH /api/me no token -> 401", api("PATCH", "/api/me", json={"shopFor": "mens"}).status_code == 401)
        crew = api("POST", "/api/crews", tok_a, json={"name": "Prices", "activity": "Gym"}).json()
        api("POST", "/api/crews/join", tok_b, json={"inviteCode": crew["inviteCode"]})
        sess = api("GET", f"/api/crews/{crew['id']}/day/2030-01-01", tok_a).json()
        jpeg = b"\xff\xd8\xff\xe0" + b"\x00" * 64
        t0 = time.time()
        up = api("POST", f"/api/sessions/{sess['id']}/picks", tok_a, files={"photo": ("o.jpg", jpeg, "image/jpeg")})
        posted = up.json()
        # Posting is instant now: 201 with analysisStatus "pending" and no items; the (mocked) analysis runs in the background.
        if not check("upload -> 201 instantly with analysisStatus pending|ready and no-store",
                     up.status_code == 201 and posted.get("analysisStatus") in ("pending", "ready") and time.time() - t0 < 5
                     and "no-store" in up.headers.get("Cache-Control", "").lower(),
                     f"{up.status_code} {up.headers.get('Cache-Control')} {str(posted)[:200]}"):
            return
        check("upload: analysisFailed false while pending", posted.get("analysisFailed") is False, repr(posted.get("analysisFailed")))
        pick = posted
        deadline = time.time() + 30
        while pick.get("analysisStatus") == "pending" and time.time() < deadline:
            time.sleep(0.2)
            g = api("GET", f"/api/picks/{posted['id']}", tok_a)
            pick = g.json() if g.status_code == 200 else pick
        if not check("GET /api/picks/:id settles to ready with 2 items (MOCK_VISION_JSON)",
                     pick.get("analysisStatus") == "ready" and len(pick.get("items", [])) == 2 and pick.get("analysisError") is None and pick.get("analyzedAt"),
                     f"{str(pick)[:300]}"):
            return
        check("pick view: note falls back to the vision summary when the owner left it blank", pick.get("note") == MOCK_VISION.get("summary"), repr(pick.get("note")))
        # owner-only retry: non-owner 403, owner -> pending again -> settles to ready; non-member GET -> 403
        check("GET /api/picks/:id non-member -> 403", api("GET", f"/api/picks/{pick['id']}", tok_c).status_code == 403)
        check("POST /api/picks/:id/analyze non-owner -> 403", api("POST", f"/api/picks/{pick['id']}/analyze", tok_b).status_code == 403)
        ra = api("POST", f"/api/picks/{pick['id']}/analyze", tok_a)
        check("POST /api/picks/:id/analyze owner -> 200 pending", ra.status_code == 200 and ra.json().get("analysisStatus") == "pending", f"{ra.status_code} {ra.text[:200]}")
        deadline = time.time() + 30
        again = ra.json()
        while again.get("analysisStatus") == "pending" and time.time() < deadline:
            time.sleep(0.2)
            again = api("GET", f"/api/picks/{pick['id']}", tok_a).json()
        check("re-analysis settles to ready with 2 items again", again.get("analysisStatus") == "ready" and len(again.get("items", [])) == 2, str(again)[:200])
        pick = again
        links = pick["items"][0]["links"]
        amazon = [l for l in links if l["label"] == "Amazon"]
        brand = [l for l in links if l["label"].endswith("site")]
        compare = [l for l in links if l["label"] == "Compare prices"]
        check("pick view: Amazon link carries ?tag=", bool(amazon) and "tag=mmvtest-20" in amazon[0]["url"], links)
        check("pick view: brand-site link Sovrn-wrapped", bool(brand) and brand[0]["url"].startswith("https://redirect.viglink.com?key=sovrn-test&u="), links)
        check("pick view: google compare link untouched", bool(compare) and compare[0]["url"].startswith("https://www.google.com/"), links)
        # owner A has shopFor=mens -> profile overrides the leggings' vision fit (womens)
        check("pick view: items carry fit from vision (womens) / unisex default when missing",
              pick["items"][0].get("fit") == "womens" and pick["items"][1].get("fit") == "unisex", [i.get("fit") for i in pick["items"]])
        check("pick view: shoppingQuery = men's + searchQuery (owner profile beats fit)",
              pick["items"][0].get("shoppingQuery") == "men's lululemon align high rise legging black", pick["items"][0].get("shoppingQuery"))
        check("pick view: searchQuery itself unchanged (stored value)", pick["items"][0]["searchQuery"] == "lululemon align high rise legging black", pick["items"][0]["searchQuery"])
        check("pick view: query already containing 'women' is not prefixed", pick["items"][1].get("shoppingQuery") == "white running shoes women", pick["items"][1].get("shoppingQuery"))
        check("pick view: Compare prices + Amazon chips use the hinted query",
              bool(compare) and "men's%20lululemon" in compare[0]["url"] and bool(amazon)
              and urllib.parse.parse_qs(urllib.parse.urlparse(amazon[0]["url"]).query).get("k", [""])[0] == "men's lululemon align high rise legging black", [compare, amazon])

        r = api("GET", f"/api/picks/{pick['id']}/prices", tok_b)
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else None
        if not check("GET /api/picks/:id/prices (member B) -> 200 {items}", r.status_code == 200 and isinstance(body, dict) and isinstance(body.get("items"), list), f"{r.status_code} {str(body)[:200]}"):
            return
        items = body["items"]
        check("prices: one entry per item, carries category/searchQuery/links/offers", len(items) == 2 and all(k in items[0] for k in ("category", "searchQuery", "links", "offers")), [list(i.keys()) for i in items])
        check("prices: items carry shoppingQuery (hinted) used for the lookup", items[0].get("shoppingQuery") == "men's lululemon align high rise legging black" and items[1].get("shoppingQuery") == "white running shoes women", [i.get("shoppingQuery") for i in items])
        offers = items[0]["offers"]
        priced = [o["price"] for o in offers if o["price"] is not None]
        check("prices: 6 offers, priced ascending then unpriced (masked Amazon) last",
              len(offers) == 6 and priced == sorted(priced) and all(o["price"] is None for o in offers[len(priced):]), [(o["seller"], o["price"]) for o in offers])
        am = [o for o in offers if o["seller"] == "Amazon.com"]
        check("prices: Amazon offer masked ('See price on Amazon', price null, tag added)", am and am[0]["price"] is None and am[0]["priceText"] == "See price on Amazon" and "tag=mmvtest-20" in am[0]["url"], am)
        others = [o for o in offers if o["seller"] != "Amazon.com"]
        check("prices: non-Amazon offers keep numeric price + priceText", all(isinstance(o["price"], (int, float)) and o["priceText"] for o in others), [(o["seller"], o["price"], o["priceText"]) for o in others])
        direct = [o for o in others if o["direct"]]
        indirect = [o for o in others if not o["direct"]]
        check("prices: every offer carries direct + retailerHost, no immersiveToken", all("direct" in o and "retailerHost" in o and "immersiveToken" not in o for o in offers), [list(o.keys()) for o in offers])
        check("prices: direct retailer offers Sovrn-wrapped, retailerHost = merchant host",
              len(direct) == 2 and all(o["url"].startswith("https://redirect.viglink.com?key=sovrn-test&u=") for o in direct) and sorted(o["retailerHost"] for o in direct) == ["s2shop.com", "target.com"],
              [(o["seller"], o["url"], o["retailerHost"]) for o in direct])
        check("prices: Target offer resolved via immersive fallback -> target.com inside the Sovrn u=",
              any(urllib.parse.parse_qs(urllib.parse.urlparse(o["url"]).query).get("u", [""])[0] == "https://www.target.com/p/no-link-item/-/A-123" for o in direct), [o["url"] for o in direct])
        check("prices: google product links not Sovrn-wrapped (not a retailer), direct:false, retailerHost ''",
              len(indirect) == 3 and all(o["url"].startswith("https://www.google.com/") and o["retailerHost"] == "" for o in indirect), [o["url"] for o in indirect])
        check("prices: Amazon masked offer still direct:true/amazon.com", am and am[0]["direct"] is True and am[0]["retailerHost"] == "amazon.com", am)
        check("prices: offers tagged source=serpapi", all(o["source"] == "serpapi" for o in offers))
        check("prices: item.links affiliate-wrapped in prices response too", any("tag=mmvtest-20" in l["url"] for l in items[0]["links"]))

        r2 = api("GET", f"/api/picks/{pick['id']}/prices", tok_a)
        check("prices: second call (cached) -> 200 identical offers", r2.status_code == 200 and r2.json()["items"][0]["offers"] == offers)
        check("prices: non-member -> 403", api("GET", f"/api/picks/{pick['id']}/prices", tok_c).status_code == 403)
        check("prices: no token -> 401", api("GET", f"/api/picks/{pick['id']}/prices").status_code == 401)
        check("prices: unknown pick -> 404", api("GET", "/api/picks/999999/prices", tok_a).status_code == 404)

        # ---- owner clears shopFor -> hint falls back to the garment's vision fit (womens), stored pick untouched
        pc = api("PATCH", "/api/me", tok_a, json={"shopFor": None})
        check("PATCH /api/me { shopFor: null } -> 200, shopFor null", pc.status_code == 200 and pc.json().get("shopFor") is None, pc.text[:200])
        sv = api("GET", f"/api/sessions/{sess['id']}", tok_b).json()
        mine = [p for p in sv["picks"] if p["id"] == pick["id"]]
        check("pick view after clearing profile: shoppingQuery = women's + searchQuery (vision fit)",
              bool(mine) and mine[0]["items"][0].get("shoppingQuery") == "women's lululemon align high rise legging black", mine and mine[0]["items"][0].get("shoppingQuery"))
        r3 = api("GET", f"/api/picks/{pick['id']}/prices", tok_b)
        check("prices after clearing profile: lookup uses the women's query (fresh cache key, still 200 with offers)",
              r3.status_code == 200 and r3.json()["items"][0]["shoppingQuery"] == "women's lululemon align high rise legging black" and len(r3.json()["items"][0]["offers"]) == 6, r3.text[:200])
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
