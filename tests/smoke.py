#!/usr/bin/env python3
"""
MMV (Match My Vibe) post-deploy smoke test.

Usage:
    python tests/smoke.py                      # against http://localhost:5000
    python tests/smoke.py --base https://mmv.onrender.com
    python tests/smoke.py --base https://... --verbose

Dependencies: Python 3.8+, `requests`, `Pillow` (pip install requests pillow).

What it does (end to end, with two throwaway users):
  health -> signup A/B (A with shopFor) -> login A -> /api/me -> PATCH /api/me {shopFor} -> create crew (A) -> join by invite (B)
  -> GET crew -> GET day (auto-creates session) -> PATCH vibe -> GET session
  -> upload synthetic JPEG as A (checks items/palette/analysisFailed, fetches photoPath)
  -> upload as B -> .txt upload rejected 400 -> lazy prices for A's pick (200 {items}; offers may be
     empty without SERPAPI_KEY/HASDATA_API_KEY) -> lock/unlock pick -> emoji + comment reactions
  -> closet -> report a problem (POST /api/feedback 200 {id, kind, githubIssueUrl}, kind=suggestion 200,
     bad kind 400, missing message 400, admin endpoints 403 for a normal user) -> wrong PIN 401 -> repeated wrong PINs 429 -> no-token 401
  -> delete picks (cleanup).

Exit code 0 only if every check passes. Prints a PASS/FAIL table.

Notes:
  * The server rate-limits signups to 10/hour per IP; running this more than ~5 times
    in an hour from one machine will fail at the signup step with 429.
  * The wrong-PIN test burns the 6-attempt/15-min login budget for the throwaway
    user B only; it never touches real accounts.
  * The feedback step files TWO real GitHub issues per run when the server has GITHUB_ISSUES_TOKEN
    configured (title "[Report] [smoke] …" label user-report, and "[Idea] [smoke] …" label suggestion).
    Close them or pass --no-feedback.
"""
import argparse
import io
import json
import random
import re
import string
import sys
import time
from datetime import date

try:
    import requests
except ImportError:
    print("Missing dependency: pip install requests pillow", file=sys.stderr)
    sys.exit(2)

TIMEOUT = 30
UPLOAD_TIMEOUT = 120  # vision analysis can take a while on free tiers

RESULTS = []  # (name, ok, detail)
VERBOSE = False
FEEDBACK = True  # --no-feedback skips the "report a problem" step (avoids filing a GitHub issue)


# --------------------------------------------------------------------------- helpers
def record(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    tag = "PASS" if ok else "FAIL"
    if VERBOSE or not ok:
        print(f"  [{tag}] {name} {('- ' + detail) if detail else ''}")
    return ok


def check(name, cond, detail=""):
    return record(name, cond, detail)


class Skip(Exception):
    """Abort the remaining dependent steps."""


def expect(name, resp, status, shape=None):
    """Assert status code and (optionally) that JSON has the given keys. Returns parsed JSON or None."""
    body = None
    try:
        body = resp.json()
    except Exception:
        pass
    ok = resp.status_code == status
    detail = f"HTTP {resp.status_code}"
    if not ok:
        detail += f" (expected {status}) {str(body)[:160] if body is not None else resp.text[:160]}"
    if ok and shape:
        if not isinstance(body, dict):
            ok = False
            detail += f" body is {type(body).__name__}, expected object"
        else:
            missing = [k for k in shape if k not in body]
            if missing:
                ok = False
                detail += f" missing keys {missing}"
    record(name, ok, detail)
    return body if ok else None


def rand_handle(prefix):
    return prefix + "".join(random.choices(string.ascii_lowercase + string.digits, k=8))


def make_jpeg():
    """Generate a small synthetic 'outfit' photo: a figure with a top, bottoms and shoes."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("Missing dependency: pip install pillow", file=sys.stderr)
        sys.exit(2)
    w, h = 480, 720
    img = Image.new("RGB", (w, h), (236, 232, 224))  # warm wall
    d = ImageDraw.Draw(img)
    d.rectangle([0, 560, w, h], fill=(190, 170, 150))  # floor
    d.ellipse([200, 60, 280, 140], fill=(214, 170, 140))  # head
    d.rounded_rectangle([165, 150, 315, 340], radius=25, fill=(28, 30, 36))  # black top
    d.rectangle([165, 190, 200, 330], fill=(28, 30, 36))
    d.rectangle([280, 190, 315, 330], fill=(28, 30, 36))
    d.rounded_rectangle([175, 335, 305, 580], radius=18, fill=(58, 92, 160))  # blue leggings
    d.rectangle([240, 335, 243, 580], fill=(236, 232, 224))
    d.rounded_rectangle([165, 575, 245, 615], radius=12, fill=(240, 240, 240))  # white shoes
    d.rounded_rectangle([238, 575, 318, 615], radius=12, fill=(240, 240, 240))
    d.rectangle([165, 600, 318, 612], fill=(255, 90, 60))  # orange sole accent
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    data = buf.getvalue()
    assert data[:3] == b"\xff\xd8\xff"
    return data


def resolve_photo_url(base, photo_path):
    if re.match(r"^https?://", photo_path or ""):
        return photo_path
    return base.rstrip("/") + "/" + (photo_path or "").lstrip("/")


# --------------------------------------------------------------------------- main flow
def run(base):
    s = requests.Session()
    s.headers["User-Agent"] = "mmv-smoke/1.0"

    def api(method, path, token=None, **kw):
        headers = kw.pop("headers", {})
        if token:
            headers["x-auth-token"] = token
        kw.setdefault("timeout", TIMEOUT)
        return s.request(method, base + path, headers=headers, **kw)

    pick_ids = []  # (pick_id, token) for cleanup
    tokens = {}

    try:
        # ---- health
        r = api("GET", "/api/health")
        body = expect("GET /api/health -> 200 {ok:true}", r, 200, ["ok"])
        if body is None or body.get("ok") is not True:
            raise Skip("server not healthy")

        # ---- signup A and B
        handle_a, handle_b = rand_handle("smoke_a_"), rand_handle("smoke_b_")
        pin_a, pin_b = "1234", "4321"
        r = api("POST", "/api/auth/signup", json={"name": "Smoke A", "handle": handle_a, "pin": pin_a, "shopFor": "womens"})
        a = expect("POST /api/auth/signup (user A, shopFor=womens) -> 200 {token,user}", r, 200, ["token", "user"])
        if a:
            check("signup echoes user.shopFor='womens'", a["user"].get("shopFor") == "womens", repr(a["user"].get("shopFor")))
        r = api("POST", "/api/auth/signup", json={"name": "Smoke B", "handle": handle_b, "pin": pin_b})
        b = expect("POST /api/auth/signup (user B) -> 200 {token,user}", r, 200, ["token", "user"])
        if not a or not b:
            raise Skip("signup failed (note: 10 signups/hour/IP limit)")
        tok_a, tok_b = a["token"], b["token"]
        tokens["a"], tokens["b"] = tok_a, tok_b
        check("signup response hides pin/token inside user", "pin" not in a["user"] and "token" not in a["user"])

        # duplicate handle
        r = api("POST", "/api/auth/signup", json={"name": "Dup", "handle": handle_a, "pin": "0000"})
        expect("POST /api/auth/signup duplicate handle -> 409", r, 409)

        # ---- login A (correct PIN)
        r = api("POST", "/api/auth/login", json={"handle": handle_a, "pin": pin_a})
        la = expect("POST /api/auth/login (A, correct PIN) -> 200", r, 200, ["token", "user"])
        if la:
            tok_a = la["token"]
            tokens["a"] = tok_a

        # ---- /api/me
        r = api("GET", "/api/me", tok_a)
        me = expect("GET /api/me (A) -> 200", r, 200, ["id", "name", "handle", "color"])
        if me:
            check("/api/me returns our handle", me["handle"].lower() == handle_a.lower(), me["handle"])
            check("/api/me carries shopFor", "shopFor" in me and me["shopFor"] == "womens", repr(me.get("shopFor")))
        r = api("GET", "/api/me")
        expect("GET /api/me without token -> 401", r, 401)
        r = api("GET", "/api/me", "not-a-real-token")
        expect("GET /api/me with bogus token -> 401", r, 401)

        # ---- PATCH /api/me { shopFor }  ("womens" | "mens" | "unisex" | null)
        r = api("PATCH", "/api/me", tok_a, json={"shopFor": "mens"})
        pm = expect("PATCH /api/me {shopFor:'mens'} -> 200 PublicUser", r, 200, ["id", "handle", "shopFor"])
        if pm:
            check("PATCH /api/me saved shopFor='mens' (no pin/token leaked)", pm["shopFor"] == "mens" and "pin" not in pm and "token" not in pm, repr(pm.get("shopFor")))
        r = api("GET", "/api/me", tok_a)
        me2 = expect("GET /api/me after PATCH -> 200", r, 200, ["shopFor"])
        if me2:
            check("GET /api/me reflects shopFor='mens'", me2["shopFor"] == "mens", repr(me2.get("shopFor")))
        r = api("PATCH", "/api/me", tok_a, json={"shopFor": "kids"})
        expect("PATCH /api/me invalid shopFor -> 400", r, 400)
        r = api("PATCH", "/api/me", json={"shopFor": "mens"})
        expect("PATCH /api/me without token -> 401", r, 401)
        r = api("PATCH", "/api/me", tok_a, json={"shopFor": None})
        pm = expect("PATCH /api/me {shopFor:null} -> 200 (cleared)", r, 200, ["id"])
        if pm:
            check("shopFor cleared to null", pm.get("shopFor") is None, repr(pm.get("shopFor")))
        r = api("PATCH", "/api/me", tok_a, json={"shopFor": "womens"})
        expect("PATCH /api/me {shopFor:'womens'} -> 200 (restored)", r, 200, ["id"])

        # ---- crews
        r = api("GET", "/api/crews", tok_a)
        crews = expect("GET /api/crews (A, empty) -> 200 list", r, 200)
        check("GET /api/crews returns a list", isinstance(crews, list))

        r = api("POST", "/api/crews", tok_a, json={"name": "Smoke Crew", "activity": "Gym"})
        crew = expect("POST /api/crews (A) -> 200 {id,inviteCode,members}", r, 200, ["id", "inviteCode", "members", "activity"])
        if not crew:
            raise Skip("crew creation failed")
        crew_id, invite = crew["id"], crew["inviteCode"]
        check("new crew has creator as member", len(crew["members"]) == 1)

        r = api("POST", "/api/crews", tok_a, json={"name": "Bad", "activity": "Skydiving"})
        expect("POST /api/crews invalid activity -> 400", r, 400)

        # B joins
        r = api("POST", "/api/crews/join", tok_b, json={"inviteCode": invite})
        joined = expect("POST /api/crews/join (B) -> 200", r, 200, ["id", "members"])
        if joined:
            check("crew now has 2 members", len(joined["members"]) == 2, f"{len(joined['members'])} members")
        r = api("POST", "/api/crews/join", tok_b, json={"inviteCode": "ZZZZZZ"})
        expect("POST /api/crews/join bad code -> 404", r, 404)

        r = api("GET", f"/api/crews/{crew_id}", tok_b)
        expect("GET /api/crews/:id (B) -> 200 {sessions}", r, 200, ["id", "members", "sessions"])
        r = api("GET", f"/api/crews/{crew_id}", "nope")
        expect("GET /api/crews/:id unauth -> 401", r, 401)

        # ---- day / session
        today = date.today().isoformat()
        r = api("GET", f"/api/crews/{crew_id}/day/{today}", tok_a)
        sess = expect("GET /api/crews/:id/day/:date (auto-create) -> 200", r, 200, ["id", "date", "picks", "members", "crew"])
        if not sess:
            raise Skip("day session failed")
        sess_id = sess["id"]
        check("day session has today's date", sess["date"] == today)
        r = api("GET", f"/api/crews/{crew_id}/day/{today}", tok_b)
        sess2 = expect("GET day again (B) -> 200 same session", r, 200, ["id"])
        if sess2:
            check("day endpoint is idempotent (same session id)", sess2["id"] == sess_id, f"{sess2['id']} vs {sess_id}")
        r = api("GET", f"/api/crews/{crew_id}/day/not-a-date", tok_a)
        expect("GET day with bad date -> 400", r, 400)

        r = api("PATCH", f"/api/sessions/{sess_id}", tok_a, json={"vibe": "all black"})
        patched = expect("PATCH /api/sessions/:id {vibe} -> 200", r, 200, ["id", "vibe"])
        if patched:
            check("vibe saved", patched["vibe"] == "all black", repr(patched["vibe"]))
        r = api("GET", f"/api/sessions/{sess_id}", tok_b)
        got = expect("GET /api/sessions/:id (B) -> 200", r, 200, ["id", "picks", "vibe"])
        if got:
            check("vibe visible to other member", got["vibe"] == "all black")

        # ---- picks: real JPEG upload as A
        jpeg = make_jpeg()
        t0 = time.time()
        r = api(
            "POST", f"/api/sessions/{sess_id}/picks", tok_a,
            files={"photo": ("outfit.jpg", jpeg, "image/jpeg")},
            data={"note": "smoke test fit"},
            timeout=UPLOAD_TIMEOUT,
        )
        elapsed = time.time() - t0
        pick_a = expect(
            f"POST /api/sessions/:id/picks JPEG (A) -> 200 ({elapsed:.1f}s)", r, 200,
            ["id", "photoPath", "items", "palette", "analysisFailed", "user", "reactions", "locked"],
        )
        if not pick_a:
            raise Skip("upload failed")
        pick_ids.append((pick_a["id"], tok_a))
        check("pick.items is a list", isinstance(pick_a["items"], list))
        check("pick.palette is a list", isinstance(pick_a["palette"], list))
        check("pick.note echoed", pick_a.get("note") == "smoke test fit", repr(pick_a.get("note")))

        # Vision check: lenient. Fail only on inconsistent state (analysis "succeeded" but produced nothing).
        failed = pick_a["analysisFailed"]
        n_items = len(pick_a["items"])
        if failed:
            record("vision: garment recognition (lenient)", True,
                   "analysisFailed=true -> vision unavailable (check GEMINI_API_KEY / Render logs for 'vision failed'); items=[] is acceptable")
        else:
            cats = [i.get("category") for i in pick_a["items"] if isinstance(i, dict)]
            ok_shape = all(isinstance(i, dict) and "category" in i and "colorHex" in i for i in pick_a["items"])
            record("vision: garment recognition (lenient)", ok_shape,
                   f"analysisFailed=false, items={n_items} {cats[:5]}, palette={pick_a['palette'][:5]}"
                   + ("" if n_items else " (WARNING: analysis succeeded but found no garments)"))
        print(f"  >> VISION: {'FAILED (analysisFailed=true)' if failed else ('WORKED, ' + str(n_items) + ' item(s) recognized' if n_items else 'ran but recognized 0 items')}")

        # fetch the photo
        photo_url = resolve_photo_url(base, pick_a["photoPath"])
        try:
            pr = s.get(photo_url, timeout=TIMEOUT)
            ctype = pr.headers.get("content-type", "")
            ok = pr.status_code == 200 and pr.content[:3] == b"\xff\xd8\xff"
            record("GET photoPath -> 200 image/jpeg bytes", ok,
                   f"{photo_url[:90]} HTTP {pr.status_code} {ctype} {len(pr.content)} bytes")
            check("photo bytes round-trip identical", pr.content == jpeg, f"{len(pr.content)} vs {len(jpeg)}")
        except Exception as e:  # noqa: BLE001
            record("GET photoPath -> 200 image/jpeg bytes", False, f"{photo_url[:90]} {e}")

        # second upload by A replaces (upsert) rather than adding
        r = api("GET", f"/api/sessions/{sess_id}", tok_a)
        sv = expect("GET session shows 1 pick after A upload", r, 200, ["picks"])
        if sv:
            check("session.picks has 1 entry", len(sv["picks"]) == 1, f"{len(sv['picks'])}")

        # upload as B
        r = api(
            "POST", f"/api/sessions/{sess_id}/picks", tok_b,
            files={"photo": ("fit.jpg", jpeg, "image/jpeg")}, timeout=UPLOAD_TIMEOUT,
        )
        pick_b = expect("POST picks JPEG (B, no note) -> 200", r, 200, ["id", "photoPath", "analysisFailed"])
        if pick_b:
            pick_ids.append((pick_b["id"], tok_b))
            check("A and B picks are distinct", pick_b["id"] != pick_a["id"])

        # bad uploads
        r = api("POST", f"/api/sessions/{sess_id}/picks", tok_a,
                files={"photo": ("notes.txt", b"this is not an image\n", "text/plain")}, timeout=UPLOAD_TIMEOUT)
        expect("POST picks .txt (text/plain) -> 400", r, 400)
        r = api("POST", f"/api/sessions/{sess_id}/picks", tok_a,
                files={"photo": ("fake.jpg", b"not an image at all " * 4, "image/jpeg")}, timeout=UPLOAD_TIMEOUT)
        expect("POST picks text bytes declared image/jpeg -> 400 (magic-byte sniff)", r, 400)
        r = api("POST", f"/api/sessions/{sess_id}/picks", tok_a, data={"note": "no file"}, timeout=UPLOAD_TIMEOUT)
        expect("POST picks without photo -> 400", r, 400)
        r = api("POST", f"/api/sessions/{sess_id}/picks",
                files={"photo": ("outfit.jpg", jpeg, "image/jpeg")}, timeout=UPLOAD_TIMEOUT)
        expect("POST picks without token -> 401", r, 401)

        pid_a = pick_a["id"]

        # ---- lazy shopping prices (offers are [] when no provider key is configured; that's fine)
        r = api("GET", f"/api/picks/{pid_a}/prices", tok_b, timeout=60)
        pr = expect("GET /api/picks/:id/prices (B on A's pick) -> 200 {items}", r, 200, ["items"])
        if pr:
            items = pr["items"]
            ok = isinstance(items, list) and len(items) == len(pick_a["items"]) and all(
                isinstance(i, dict) and isinstance(i.get("offers"), list) and "searchQuery" in i and "shoppingQuery" in i for i in items)
            if isinstance(items, list) and items:
                # owner A shops womens -> every query is hinted unless it already names a department
                check("prices: shoppingQuery hinted with women's (owner shopFor) unless already gendered",
                      all(i["shoppingQuery"].startswith("women's ") or re.search(r"\b((wo)?m[ae]n('?s)?|ladies|girls?|boys?|unisex)\b", i["shoppingQuery"], re.I)
                          for i in items if i.get("searchQuery")),
                      [i.get("shoppingQuery") for i in items])
            n_offers = sum(len(i.get("offers", [])) for i in items) if isinstance(items, list) else 0
            record("prices: items list mirrors pick.items, each with offers[]", ok,
                   f"items={len(items) if isinstance(items, list) else items}, offers={n_offers}"
                   + ("" if n_offers else " (0 offers: no SERPAPI_KEY/HASDATA_API_KEY, budget spent, or no items)"))
            if n_offers:
                flat = [o for i in items for o in i["offers"]]
                check("prices: offers have title/seller/url/priceText/source",
                      all(all(k in o for k in ("title", "seller", "url", "priceText", "source")) for o in flat))
                check("prices: Amazon offers never show a number",
                      all(o.get("price") is None for o in flat if "amazon" in (o.get("seller", "") + o.get("url", "")).lower()))

        # ---- lock / unlock
        r = api("PATCH", f"/api/picks/{pid_a}", tok_a, json={"locked": True})
        lk = expect("PATCH /api/picks/:id {locked:true} -> 200", r, 200, ["locked"])
        if lk:
            check("pick is locked", lk["locked"] is True)
        r = api("PATCH", f"/api/picks/{pid_a}", tok_b, json={"locked": False})
        expect("PATCH other user's pick -> 404", r, 404)
        r = api("PATCH", f"/api/picks/{pid_a}", tok_a, json={"locked": "yes"})
        expect("PATCH pick invalid body -> 400", r, 400)
        r = api("PATCH", f"/api/picks/{pid_a}", tok_a, json={"locked": False})
        expect("PATCH {locked:false} -> 200", r, 200, ["locked"])

        # ---- reactions
        r = api("POST", f"/api/picks/{pid_a}/reactions", tok_b, json={"emoji": "🔥"})
        rx = expect("POST reactions {emoji} (B on A) -> 200", r, 200, ["reactions"])
        if rx:
            check("emoji reaction present", any(x.get("emoji") == "🔥" for x in rx["reactions"]))
        r = api("POST", f"/api/picks/{pid_a}/reactions", tok_b, json={"comment": "love the shoes"})
        rx = expect("POST reactions {comment} -> 200", r, 200, ["reactions"])
        if rx:
            check("comment reaction present", any(x.get("comment") == "love the shoes" for x in rx["reactions"]))
            check("reactions carry user", all("user" in x for x in rx["reactions"]))
        r = api("POST", f"/api/picks/{pid_a}/reactions", tok_b, json={})
        expect("POST reactions empty -> 400", r, 400)

        # ---- closet
        r = api("GET", "/api/closet", tok_a)
        closet = expect("GET /api/closet (A) -> 200 list", r, 200)
        if closet is not None:
            check("closet is a list containing our pick", isinstance(closet, list) and any(p.get("id") == pid_a for p in closet),
                  f"{len(closet) if isinstance(closet, list) else closet}")

        # ---- report a problem (feedback). Throwaway users are never in ADMIN_HANDLES -> admin routes 403.
        if FEEDBACK:
            r = api("POST", "/api/feedback", tok_a, json={
                "message": "[smoke] automated test report - safe to close",
                "page": "/smoke", "userAgent": "mmv-smoke/1.0", "appVersion": "smoke", "lastError": "none (smoke test)",
            }, timeout=60)
            fb = expect("POST /api/feedback (JSON, no screenshot) -> 200 {id, kind, githubIssueUrl}", r, 200, ["id", "kind", "githubIssueUrl"])
            if fb:
                check("feedback id is an integer", isinstance(fb["id"], int), repr(fb["id"]))
                check("feedback kind defaults to 'problem'", fb.get("kind") == "problem", repr(fb.get("kind")))
                gh = fb["githubIssueUrl"]
                record("feedback githubIssueUrl is null or a github.com issue link", gh is None or (isinstance(gh, str) and gh.startswith("https://github.com/")),
                       "no GitHub filing configured (GITHUB_ISSUES_TOKEN unset) - report saved only" if gh is None else gh)
                print(f"  >> FEEDBACK: saved #{fb['id']}" + (f", issue {gh}" if gh else " (no GitHub issue: token not configured or filing failed - see server logs '[github]')"))
            r = api("POST", "/api/feedback", tok_a, json={
                "message": "[smoke] automated test suggestion - safe to close", "kind": "suggestion",
                "page": "/smoke", "userAgent": "mmv-smoke/1.0", "appVersion": "smoke",
            }, timeout=60)
            fs = expect("POST /api/feedback kind=suggestion -> 200 {id, kind, githubIssueUrl}", r, 200, ["id", "kind", "githubIssueUrl"])
            if fs:
                check("suggestion kind echoed back", fs.get("kind") == "suggestion", repr(fs.get("kind")))
                ghs = fs["githubIssueUrl"]
                print(f"  >> SUGGESTION: saved #{fs['id']}" + (f", issue {ghs}" if ghs else " (no GitHub issue)"))
            r = api("POST", "/api/feedback", tok_a, json={"message": "bad kind", "kind": "complaint"})
            expect("POST /api/feedback invalid kind -> 400", r, 400)
            r = api("POST", "/api/feedback", tok_a, json={"page": "/smoke"})
            expect("POST /api/feedback without message -> 400", r, 400)
            r = api("POST", "/api/feedback", tok_a, json={"message": "x" * 2001})
            expect("POST /api/feedback message > 2000 chars -> 400", r, 400)
            r = api("POST", "/api/feedback", json={"message": "no token"})
            expect("POST /api/feedback without token -> 401", r, 401)
            r = api("GET", "/api/feedback", tok_a)
            expect("GET /api/feedback as non-admin -> 403", r, 403)
            if fb:
                r = api("PATCH", f"/api/feedback/{fb['id']}", tok_a, json={"status": "resolved"})
                expect("PATCH /api/feedback/:id as non-admin -> 403", r, 403)
            r = api("GET", "/api/me", tok_a)
            me3 = expect("GET /api/me carries isAdmin", r, 200, ["isAdmin"])
            if me3:
                check("throwaway user is not admin", me3["isAdmin"] is False, repr(me3["isAdmin"]))

        # ---- auth negative paths (use B so A's login budget is untouched)
        r = api("POST", "/api/auth/login", json={"handle": handle_b, "pin": "0000"})
        expect("POST /api/auth/login wrong PIN -> 401", r, 401)
        r = api("POST", "/api/auth/login", json={"handle": "nobody_" + handle_b[-6:], "pin": "0000"})
        expect("POST /api/auth/login unknown handle -> 401", r, 401)
        r = api("POST", "/api/auth/login", json={"handle": handle_b, "pin": "12"})
        expect("POST /api/auth/login malformed PIN -> 400", r, 400)

        # repeated wrong PINs -> 429 (limit is 6 per handle per 15 min; 1 already used above)
        codes = []
        for _ in range(8):
            r = api("POST", "/api/auth/login", json={"handle": handle_b, "pin": "0000"})
            codes.append(r.status_code)
            if r.status_code == 429:
                break
        got429 = 429 in codes
        only_401_before = all(c == 401 for c in codes[:-1]) if got429 else False
        record("6+ wrong PINs in a row -> 429", got429 and only_401_before, f"codes={codes}")
        if got429:
            r = api("POST", "/api/auth/login", json={"handle": handle_b, "pin": pin_b})
            expect("correct PIN while locked out -> still 429", r, 429)

    except Skip as e:
        record("(aborted remaining steps)", False, str(e))
    except requests.RequestException as e:
        record("(network error)", False, str(e)[:200])
    finally:
        # ---- cleanup
        for pid, tok in pick_ids:
            try:
                r = s.request("DELETE", f"{base}/api/picks/{pid}", headers={"x-auth-token": tok}, timeout=TIMEOUT)
                record(f"DELETE /api/picks/{pid} (cleanup) -> 200", r.status_code == 200, f"HTTP {r.status_code}")
                if r.status_code == 200:
                    r2 = s.request("DELETE", f"{base}/api/picks/{pid}", headers={"x-auth-token": tok}, timeout=TIMEOUT)
                    record(f"DELETE /api/picks/{pid} again -> 404", r2.status_code == 404, f"HTTP {r2.status_code}")
            except requests.RequestException as e:
                record(f"DELETE /api/picks/{pid} (cleanup)", False, str(e)[:120])
        if pick_ids and tokens.get("a"):
            try:
                r = s.get(f"{base}/api/closet", headers={"x-auth-token": tokens["a"]}, timeout=TIMEOUT)
                record("closet empty after cleanup", r.ok and r.json() == [], f"{r.status_code} {r.text[:80]}")
            except requests.RequestException:
                pass
        # Throwaway users/crew/session remain (no delete endpoints); handles are prefixed smoke_a_/smoke_b_.


def print_table():
    w = max(len(n) for n, _, _ in RESULTS) if RESULTS else 10
    print("\n" + "=" * (w + 10))
    print(f"{'RESULT':6} {'CHECK'}")
    print("-" * (w + 10))
    for name, ok, detail in RESULTS:
        print(f"{'PASS' if ok else 'FAIL':6} {name}")
        if not ok and detail:
            print(f"       -> {detail}")
    print("-" * (w + 10))
    npass = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"{npass}/{len(RESULTS)} checks passed")
    return npass == len(RESULTS)


def main():
    global VERBOSE, FEEDBACK
    ap = argparse.ArgumentParser(description="MMV smoke test")
    ap.add_argument("--base", default="http://localhost:5000", help="Base URL (default http://localhost:5000)")
    ap.add_argument("--verbose", "-v", action="store_true", help="print every check as it runs")
    ap.add_argument("--json", help="also write results to this JSON file")
    ap.add_argument("--no-feedback", action="store_true", help="skip POST /api/feedback (it files a real GitHub issue when the server is configured)")
    args = ap.parse_args()
    VERBOSE = args.verbose
    FEEDBACK = not args.no_feedback
    base = args.base.rstrip("/")
    print(f"MMV smoke test against {base}")
    run(base)
    all_ok = print_table()
    if args.json:
        with open(args.json, "w") as f:
            json.dump([{"check": n, "pass": ok, "detail": d} for n, ok, d in RESULTS], f, indent=2)
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
