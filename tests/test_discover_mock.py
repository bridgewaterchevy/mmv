#!/usr/bin/env python3
"""
Offline test for Discover (server/discover.ts + storage): public shoppable posts, likes, follows, reports, admin
moderation. No network: vision is mocked through MOCK_VISION_JSON and the price provider through MOCK_PRICES_JSON.

    python tests/test_discover_mock.py          # from the repo root; needs node_modules + `requests`

Boots the real server on a spare port (throwaway pglite dir, local ./uploads) with ADMIN_HANDLES=disc_admin and
PRICE_LOOKUPS_PER_DAY=1, then checks:
  share (401 / 403 non-owner / 400 bad vibe, bad photoIds, long caption / 201 PostView, photoIds default = all photos,
  re-share updates in place, one post per pick), feed pagination (12/page, opaque cursor, no overlap, newest first,
  bad cursor 400), vibe filter, top sort (like_count desc then created desc, cursor), anonymous read (likedByMe /
  isFollowedByMe / isMine false, pickId null, Cache-Control: no-store), like toggle, follow toggle (+ self 400,
  unknown handle 404), public profile (first name only, bio via PATCH /api/me, counts, /api/me postCount +
  followerCount), report -> auto-hide at 3 distinct reporters (same reporter twice counts once, 5/h/IP, owner 400,
  owner re-share stays hidden, admin reactivates), admin status changes (403 for non-admin, filters, 400 bad status,
  reports list), owner delete (-> 404, re-share reactivates), photo removal / re-post / pick deletion cascades,
  privacy leak checks on every public payload (pick note, crew name, invite code, session id, non-public photo url,
  shopFor, token, pin), prices via post (same offers as the pick route, shared budget + cache, 30/h/IP).
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = []

MOCK_VISION = {
    "summary": "Black leggings with white shoes",
    "palette": ["#1C1E24", "#F0F0F0"],
    "items": [
        {"category": "leggings", "description": "black high-rise leggings", "colorName": "black", "colorHex": "#1C1E24",
         "brandGuess": "lululemon", "searchQuery": "lululemon align high rise legging black", "fit": "womens"},
    ],
}
MOCK_SERPAPI = {
    "shopping_results": [
        {"title": "Align High-Rise Pant", "source": "lululemon", "price": "$98.00", "extracted_price": 98,
         "link": "https://shop.lululemon.com/p/align-pant", "product_link": "https://www.google.com/shopping/product/1"},
        {"title": "Align Dupe", "source": "Amazon.com", "price": "$29.99", "extracted_price": 29.99,
         "link": "https://www.amazon.com/dp/B0X"},
    ]
}
PRIVATE_NOTE = "PRIVATE_NOTE_do_not_leak_7731"
CREW_NAME = "SecretCrewName_9912"
PAGE = 12


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond), detail))
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" - {detail}" if (detail and not cond) else ""))
    return cond


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def rnd(prefix):
    return prefix + "".join(random.choices(string.ascii_lowercase, k=8))


JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


def leak_check(label, payload, forbidden):
    """Assert none of the forbidden strings appear anywhere in the serialised payload."""
    blob = json.dumps(payload)
    hits = [k for k, v in forbidden.items() if v and v in blob]
    check(f"privacy: {label} leaks none of {sorted(forbidden)}", not hits, f"leaked {hits}")


def main():
    try:
        import requests
    except ImportError:
        print("pip install requests", file=sys.stderr)
        return 2
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    tmp = tempfile.mkdtemp(prefix="mmv-discover-")
    env = {**os.environ, "PORT": str(port), "NODE_ENV": "development", "PGLITE_DIR": os.path.join(tmp, "pglite"),
           "MOCK_VISION_JSON": json.dumps(MOCK_VISION), "MOCK_PRICES_JSON": json.dumps(MOCK_SERPAPI),
           "ADMIN_HANDLES": "disc_admin", "PRICE_LOOKUPS_PER_DAY": "1", "SOVRN_API_KEY": "", "AMAZON_ASSOCIATES_TAG": ""}
    for k in ("SERPAPI_KEY", "HASDATA_API_KEY", "DATABASE_URL", "SUPABASE_DB_PASSWORD", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
              "GEMINI_API_KEY", "MOCK_IMMERSIVE_JSON", "GITHUB_ISSUES_TOKEN"):
        env.pop(k, None)
    log = open(os.path.join(tmp, "server.log"), "w")
    proc = subprocess.Popen(["npx", "tsx", "server/index.ts"], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    uploaded = []
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
            return 1
        if proc.poll() is not None:
            log.flush()
            check("server booted", False, open(os.path.join(tmp, "server.log")).read()[-800:])
            return 1
        check("server booted", True)

        def api(method, path, token=None, ip=None, **kw):
            headers = kw.pop("headers", {})
            if token:
                headers["x-auth-token"] = token
            if ip:
                headers["x-forwarded-for"] = ip
            return requests.request(method, base + path, headers=headers, timeout=30, **kw)

        def signup(name, handle, **extra):
            r = api("POST", "/api/auth/signup", json={"name": name, "handle": handle, "pin": "1234", **extra})
            assert r.status_code == 200, r.text
            return r.json()

        def wait_ready(pick_id, token):
            deadline = time.time() + 30
            while time.time() < deadline:
                g = api("GET", f"/api/picks/{pick_id}", token)
                if g.status_code == 200 and g.json().get("analysisStatus") != "pending":
                    return g.json()
                time.sleep(0.2)
            return None

        def upload(session_id, token, n_photos=1, note=None):
            files = [("photo", (f"p{i}.jpg", JPEG, "image/jpeg")) for i in range(n_photos)]
            r = api("POST", f"/api/sessions/{session_id}/picks", token, files=files, data={"note": note} if note else None)
            assert r.status_code == 201, r.text
            pk = r.json()
            for ph in pk["photos"]:
                uploaded.append(ph["url"])
            return pk

        # ---- people: A (owner, two-word name, shops womens), B, C (plain readers), admin
        a = signup("Alice Van Der Berg", rnd("disc_a_"), shopFor="womens")
        b = signup("Bob", rnd("disc_b_"))
        c = signup("Cara Lee", rnd("disc_c_"))
        adm = signup("Ada Min", "disc_admin")
        tok_a, tok_b, tok_c, tok_adm = a["token"], b["token"], c["token"], adm["token"]
        handle_a = a["user"]["handle"]
        check("signup echoes bio: null on the PublicUser", a["user"].get("bio") is None and "bio" in a["user"], str(a["user"]))
        check("GET /api/me isAdmin true for ADMIN_HANDLES", api("GET", "/api/me", tok_adm).json().get("isAdmin") is True)

        crew = api("POST", "/api/crews", tok_a, json={"name": CREW_NAME, "activity": "Gym"}).json()
        api("POST", "/api/crews/join", tok_b, json={"inviteCode": crew["inviteCode"]})
        invite = crew["inviteCode"]
        sess = api("GET", f"/api/crews/{crew['id']}/day/2030-01-01", tok_a).json()
        pick = upload(sess["id"], tok_a, n_photos=2, note=PRIVATE_NOTE)
        ready = wait_ready(pick["id"], tok_a)
        if not check("A's 2-photo pick settles to ready with 1 mocked item", ready and ready["analysisStatus"] == "ready" and len(ready["items"]) == 1, str(ready)[:200]):
            return 1
        pick = ready
        photo_pub, photo_priv = pick["photos"][0], pick["photos"][1]
        FORBIDDEN = {"note": PRIVATE_NOTE, "crew": CREW_NAME, "invite": invite, "sessionId": '"sessionId"', "private photo": photo_priv["url"],
                     "token": tok_a, "shopFor key": '"shopFor"', "pin": '"pin"', "full name": "Van Der Berg"}

        # ================= share =================
        print("-- share")
        check("POST /api/picks/:id/share without token -> 401", api("POST", f"/api/picks/{pick['id']}/share", json={"vibe": "gym"}).status_code == 401)
        check("POST share by non-owner (B, same crew) -> 403", api("POST", f"/api/picks/{pick['id']}/share", tok_b, json={"vibe": "gym"}).status_code == 403)
        check("POST share unknown pick -> 404", api("POST", "/api/picks/999999/share", tok_a, json={"vibe": "gym"}).status_code == 404)
        check("POST share bad vibe -> 400", api("POST", f"/api/picks/{pick['id']}/share", tok_a, json={"vibe": "skydiving"}).status_code == 400)
        check("POST share missing vibe -> 400", api("POST", f"/api/picks/{pick['id']}/share", tok_a, json={"caption": "x"}).status_code == 400)
        check("POST share caption > 140 -> 400", api("POST", f"/api/picks/{pick['id']}/share", tok_a, json={"vibe": "gym", "caption": "x" * 141}).status_code == 400)
        r = api("POST", f"/api/picks/{pick['id']}/share", tok_a, json={"vibe": "gym", "photoIds": [999999]})
        check("POST share with a photoId of another pick -> 400", r.status_code == 400, r.text[:200])
        check("POST share with empty photoIds -> 400", api("POST", f"/api/picks/{pick['id']}/share", tok_a, json={"vibe": "gym", "photoIds": []}).status_code == 400)

        r = api("POST", f"/api/picks/{pick['id']}/share", tok_a, json={"vibe": "gym", "caption": "  leg day  "})
        post = r.json() if r.status_code == 201 else {}
        shape = ["id", "caption", "vibe", "createdAt", "likeCount", "likedByMe", "photos", "items", "palette", "analysisStatus", "author", "isMine", "status", "pickId"]
        check("POST share (owner, photoIds omitted) -> 201 PostView with every documented key", r.status_code == 201 and all(k in post for k in shape),
              f"{r.status_code} missing={[k for k in shape if k not in post]}")
        check("share response Cache-Control: no-store", "no-store" in r.headers.get("Cache-Control", "").lower())
        check("photoIds omitted on create = every photo of the pick ({id,url} only, position order)",
              [p["id"] for p in post.get("photos", [])] == [photo_pub["id"], photo_priv["id"]] and all(set(p) == {"id", "url"} for p in post["photos"]), str(post.get("photos")))
        check("caption trimmed, vibe stored, status active, likeCount 0", post.get("caption") == "leg day" and post.get("vibe") == "gym" and post.get("status") == "active" and post.get("likeCount") == 0)
        check("owner view: isMine true, pickId = the pick", post.get("isMine") is True and post.get("pickId") == pick["id"])
        check("items = the pick's aggregated items (decorated with shoppingQuery), palette, analysisStatus ready",
              len(post.get("items", [])) == 1 and post["items"][0].get("shoppingQuery", "").startswith("women's ") and post.get("palette") == pick["palette"] and post.get("analysisStatus") == "ready",
              str(post.get("items"))[:200])
        check("author: first name only, handle, color, isFollowedByMe false for self",
              post.get("author", {}).get("name") == "Alice" and post["author"].get("handle") == handle_a and post["author"].get("color") and post["author"].get("isFollowedByMe") is False, str(post.get("author")))
        check("author card has exactly {id,name,handle,color,isFollowedByMe}", set(post.get("author", {})) == {"id", "name", "handle", "color", "isFollowedByMe"}, str(post.get("author")))
        post_id = post["id"]

        # re-share updates in place, restricting to the public photo
        r = api("POST", f"/api/picks/{pick['id']}/share", tok_a, json={"vibe": "run", "caption": "updated", "photoIds": [photo_pub["id"]]})
        post2 = r.json()
        check("re-share -> 201 same post id (one post per pick), fields updated", r.status_code == 201 and post2["id"] == post_id and post2["vibe"] == "run" and post2["caption"] == "updated", str(post2)[:200])
        check("re-share with photoIds restricts the public photos", [p["id"] for p in post2["photos"]] == [photo_pub["id"]], str(post2["photos"]))
        r = api("POST", f"/api/picks/{pick['id']}/share", tok_a, json={"vibe": "gym", "caption": "", "photoIds": [photo_pub["id"], photo_pub["id"]]})
        post3 = r.json()
        check("re-share: blank caption -> null, duplicate photoIds de-duplicated, photoIds omitted later keeps selection",
              r.status_code == 201 and post3["caption"] is None and [p["id"] for p in post3["photos"]] == [photo_pub["id"]], str(post3)[:200])
        r = api("POST", f"/api/picks/{pick['id']}/share", tok_a, json={"vibe": "gym", "caption": "leg day"})
        check("re-share without photoIds keeps the previous selection", r.status_code == 201 and [p["id"] for p in r.json()["photos"]] == [photo_pub["id"]])

        # ================= anonymous read + privacy =================
        print("-- anonymous read")
        r = api("GET", f"/api/posts/{post_id}")
        anon = r.json()
        check("GET /api/posts/:id anonymous -> 200", r.status_code == 200, r.text[:200])
        check("anonymous: likedByMe false, isFollowedByMe false, isMine false, pickId null",
              anon.get("likedByMe") is False and anon["author"].get("isFollowedByMe") is False and anon.get("isMine") is False and anon.get("pickId") is None, str(anon)[:200])
        check("GET /api/posts/:id Cache-Control: no-store", "no-store" in r.headers.get("Cache-Control", "").lower())
        check("anonymous: only the chosen photo is returned", [p["id"] for p in anon["photos"]] == [photo_pub["id"]], str(anon["photos"]))
        leak_check("GET /api/posts/:id (anonymous)", anon, FORBIDDEN)
        r = api("GET", "/api/discover")
        feed = r.json()
        check("GET /api/discover anonymous -> 200 {posts, nextCursor}", r.status_code == 200 and isinstance(feed.get("posts"), list) and "nextCursor" in feed, r.text[:200])
        check("GET /api/discover Cache-Control: no-store", "no-store" in r.headers.get("Cache-Control", "").lower())
        check("feed contains our post", any(p["id"] == post_id for p in feed["posts"]))
        leak_check("GET /api/discover (anonymous)", feed, FORBIDDEN)
        r = api("GET", f"/api/users/{handle_a}/posts")
        leak_check("GET /api/users/:handle/posts (anonymous)", r.json(), FORBIDDEN)
        r = api("GET", f"/api/users/{handle_a}")
        leak_check("GET /api/users/:handle (anonymous)", r.json(), FORBIDDEN)
        r = api("GET", f"/api/posts/{post_id}", "bogus-token")
        check("bogus token on a public route is treated as anonymous (200, likedByMe false)", r.status_code == 200 and r.json()["likedByMe"] is False)
        # other members' private views are untouched
        check("GET /api/picks/:id still needs auth (401)", api("GET", f"/api/picks/{pick['id']}").status_code == 401)
        check("GET /api/picks/:id for a non-member (C) still 403", api("GET", f"/api/picks/{pick['id']}", tok_c).status_code == 403)

        # ================= like =================
        print("-- like")
        check("POST /api/posts/:id/like without token -> 401", api("POST", f"/api/posts/{post_id}/like").status_code == 401)
        check("POST like unknown post -> 404", api("POST", "/api/posts/999999/like", tok_b).status_code == 404)
        r = api("POST", f"/api/posts/{post_id}/like", tok_b)
        check("POST like (B) -> {likeCount:1, likedByMe:true}", r.status_code == 200 and r.json() == {"likeCount": 1, "likedByMe": True}, r.text)
        r = api("POST", f"/api/posts/{post_id}/like", tok_c)
        check("POST like (C) -> likeCount 2", r.status_code == 200 and r.json() == {"likeCount": 2, "likedByMe": True}, r.text)
        g = api("GET", f"/api/posts/{post_id}", tok_b).json()
        check("GET post as B: likeCount 2, likedByMe true", g["likeCount"] == 2 and g["likedByMe"] is True)
        check("GET post anonymous: likeCount 2, likedByMe false", api("GET", f"/api/posts/{post_id}").json()["likedByMe"] is False)
        r = api("POST", f"/api/posts/{post_id}/like", tok_c)
        check("POST like again (C) toggles off -> likeCount 1, likedByMe false", r.json() == {"likeCount": 1, "likedByMe": False}, r.text)

        # ================= follow / profile =================
        print("-- follow / profile")
        check("POST /api/users/:handle/follow without token -> 401", api("POST", f"/api/users/{handle_a}/follow").status_code == 401)
        check("POST follow self -> 400", api("POST", f"/api/users/{handle_a}/follow", tok_a).status_code == 400)
        check("POST follow unknown handle -> 404", api("POST", "/api/users/nobody_here_zz/follow", tok_b).status_code == 404)
        check("GET /api/users/:handle unknown -> 404", api("GET", "/api/users/nobody_here_zz").status_code == 404)
        r = api("POST", f"/api/users/{handle_a}/follow", tok_b)
        check("POST follow (B -> A) -> {following:true, followerCount:1}", r.status_code == 200 and r.json() == {"following": True, "followerCount": 1}, r.text)
        r = api("POST", f"/api/users/@{handle_a.upper()}/follow", tok_c)
        check("POST follow accepts @Handle in any case (C -> A) -> followerCount 2", r.status_code == 200 and r.json() == {"following": True, "followerCount": 2}, r.text)
        prof = api("GET", f"/api/users/{handle_a}", tok_b).json()
        check("GET /api/users/:handle (B) -> profile shape", set(prof) == {"id", "name", "handle", "color", "bio", "followerCount", "followingCount", "postCount", "isFollowedByMe", "isMe"}, str(prof))
        check("profile: first name only, counts (2 followers, 0 following, 1 post), isFollowedByMe true, isMe false",
              prof.get("name") == "Alice" and prof.get("followerCount") == 2 and prof.get("followingCount") == 0 and prof.get("postCount") == 1 and prof.get("isFollowedByMe") is True and prof.get("isMe") is False, str(prof))
        prof_anon = api("GET", f"/api/users/{handle_a}").json()
        check("profile anonymous: isFollowedByMe false, isMe false", prof_anon["isFollowedByMe"] is False and prof_anon["isMe"] is False)
        check("profile as self: isMe true", api("GET", f"/api/users/{handle_a}", tok_a).json()["isMe"] is True)
        g = api("GET", f"/api/posts/{post_id}", tok_b).json()
        check("post as B after following: author.isFollowedByMe true", g["author"]["isFollowedByMe"] is True)
        me_b = api("GET", "/api/me", tok_b).json()
        me_a = api("GET", "/api/me", tok_a).json()
        check("GET /api/me carries postCount / followerCount / followingCount", me_a.get("postCount") == 1 and me_a.get("followerCount") == 2 and me_a.get("followingCount") == 0 and me_b.get("followingCount") == 1, f"{me_a} {me_b}")
        r = api("POST", f"/api/users/{handle_a}/follow", tok_c)
        check("POST follow again (C) toggles off -> followerCount 1", r.json() == {"following": False, "followerCount": 1}, r.text)
        # bio
        r = api("PATCH", "/api/me", tok_a, json={"bio": "  Lifts, runs, brunches.  "})
        check("PATCH /api/me {bio} -> 200 trimmed bio, shopFor untouched", r.status_code == 200 and r.json().get("bio") == "Lifts, runs, brunches." and r.json().get("shopFor") == "womens", r.text[:200])
        check("PATCH /api/me bio > 120 -> 400", api("PATCH", "/api/me", tok_a, json={"bio": "x" * 121}).status_code == 400)
        check("PATCH /api/me {} -> 400", api("PATCH", "/api/me", tok_a, json={}).status_code == 400)
        check("PATCH /api/me {shopFor} still works alone", api("PATCH", "/api/me", tok_a, json={"shopFor": "womens"}).status_code == 200)
        check("profile shows the bio", api("GET", f"/api/users/{handle_a}").json().get("bio") == "Lifts, runs, brunches.")
        r = api("PATCH", "/api/me", tok_a, json={"bio": ""})
        check("PATCH /api/me {bio:''} clears it (null)", r.status_code == 200 and r.json().get("bio") is None, r.text[:200])
        r = api("PATCH", "/api/me", tok_a, json={"bio": "hi", "shopFor": "mens"})
        check("PATCH /api/me {bio, shopFor} together", r.status_code == 200 and r.json().get("bio") == "hi" and r.json().get("shopFor") == "mens", r.text[:200])
        api("PATCH", "/api/me", tok_a, json={"shopFor": "womens"})

        # ================= feed: pagination / vibe / top =================
        print("-- feed")
        # B posts in the shared crew (dates 2030-02-xx); C creates its own crew. Upload limiter is 20/h/user.
        vibes = ["run", "gym", "brunch", "travel", "other", "golf", "pickleball", "date-night"]
        made = []  # (post_id, vibe, owner_token)
        for i in range(8):
            s = api("GET", f"/api/crews/{crew['id']}/day/2030-02-{i + 1:02d}", tok_b).json()
            pk = upload(s["id"], tok_b)
            sp = api("POST", f"/api/picks/{pk['id']}/share", tok_b, json={"vibe": vibes[i % len(vibes)], "caption": f"b{i}"})
            assert sp.status_code == 201, sp.text
            made.append((sp.json()["id"], vibes[i % len(vibes)], tok_b))
        crew_c = api("POST", "/api/crews", tok_c, json={"name": "C crew", "activity": "Run club"}).json()
        for i in range(7):
            s = api("GET", f"/api/crews/{crew_c['id']}/day/2030-03-{i + 1:02d}", tok_c).json()
            pk = upload(s["id"], tok_c)
            sp = api("POST", f"/api/picks/{pk['id']}/share", tok_c, json={"vibe": "run", "caption": f"c{i}"})
            assert sp.status_code == 201, sp.text
            made.append((sp.json()["id"], "run", tok_c))
        total_active = 1 + len(made)  # 16
        r = api("GET", "/api/discover")
        p1 = r.json()
        check(f"page 1: {PAGE} posts + nextCursor", len(p1["posts"]) == PAGE and isinstance(p1.get("nextCursor"), str) and p1["nextCursor"], f"{len(p1['posts'])} {p1.get('nextCursor')!r}")
        ts = [p["createdAt"] for p in p1["posts"]]
        check("page 1 is newest first", ts == sorted(ts, reverse=True), str(ts)[:200])
        r = api("GET", f"/api/discover?cursor={p1['nextCursor']}")
        p2 = r.json()
        check(f"page 2: remaining {total_active - PAGE} posts, nextCursor null", r.status_code == 200 and len(p2["posts"]) == total_active - PAGE and p2["nextCursor"] is None, f"{r.status_code} {len(p2.get('posts', []))} {p2.get('nextCursor')!r}")
        ids1, ids2 = {p["id"] for p in p1["posts"]}, {p["id"] for p in p2["posts"]}
        check("pages do not overlap and together cover every active post", not (ids1 & ids2) and ids1 | ids2 == {post_id, *[m[0] for m in made]})
        check("GET /api/discover?cursor=garbage -> 400", api("GET", "/api/discover?cursor=not-a-cursor").status_code == 400)
        check("GET /api/discover?sort=bogus -> 400", api("GET", "/api/discover?sort=bogus").status_code == 400)
        check("GET /api/discover?vibe=bogus -> 400", api("GET", "/api/discover?vibe=bogus").status_code == 400)
        leak_check("GET /api/discover page 1", p1, FORBIDDEN)
        # vibe filter
        r = api("GET", "/api/discover?vibe=run")
        run_posts = r.json()["posts"]
        expected_run = {m[0] for m in made if m[1] == "run"}
        check("vibe=run returns exactly the run posts (<= 12) and nothing else", r.status_code == 200 and all(p["vibe"] == "run" for p in run_posts) and {p["id"] for p in run_posts} <= expected_run and len(run_posts) == min(PAGE, len(expected_run)),
              f"{[p['vibe'] for p in run_posts]}")
        r = api("GET", "/api/discover?vibe=golf")
        check("vibe=golf -> the single golf post, nextCursor null", [p["vibe"] for p in r.json()["posts"]] == ["golf"] and r.json()["nextCursor"] is None, r.text[:200])
        # top sort: like a few posts with different weights
        liked_most, liked_mid = made[2][0], made[5][0]
        for tok in (tok_a, tok_b, tok_c, tok_adm):
            api("POST", f"/api/posts/{liked_most}/like", tok)
        for tok in (tok_a, tok_adm):
            api("POST", f"/api/posts/{liked_mid}/like", tok)
        r = api("GET", "/api/discover?sort=top")
        top = r.json()["posts"]
        check("sort=top: first = 4 likes, second = 2 likes, third = our 1-like post", [p["id"] for p in top[:3]] == [liked_most, liked_mid, post_id] and [p["likeCount"] for p in top[:3]] == [4, 2, 1], str([(p["id"], p["likeCount"]) for p in top[:4]]))
        rest = top[3:]
        check("sort=top: ties (0 likes) ordered newest first", all(p["likeCount"] == 0 for p in rest) and [p["createdAt"] for p in rest] == sorted([p["createdAt"] for p in rest], reverse=True))
        r2 = api("GET", f"/api/discover?sort=top&cursor={r.json()['nextCursor']}")
        top2 = r2.json()["posts"]
        check("sort=top page 2 continues without overlap and covers the rest", r2.status_code == 200 and not ({p["id"] for p in top} & {p["id"] for p in top2}) and len(top) + len(top2) == total_active and r2.json()["nextCursor"] is None,
              f"{r2.status_code} {len(top)}+{len(top2)}")
        r = api("GET", "/api/discover?sort=top&vibe=run")
        check("sort=top + vibe=run: only run posts, like_count desc", all(p["vibe"] == "run" for p in r.json()["posts"]) and [p["likeCount"] for p in r.json()["posts"]] == sorted([p["likeCount"] for p in r.json()["posts"]], reverse=True))
        # user posts page
        r = api("GET", f"/api/users/{api('GET', '/api/me', tok_c).json()['handle']}/posts")
        check("GET /api/users/:handle/posts -> C's 7 posts newest first, nextCursor null", r.status_code == 200 and len(r.json()["posts"]) == 7 and r.json()["nextCursor"] is None and all(p["author"]["handle"].startswith("disc_c_") for p in r.json()["posts"]), r.text[:200])
        check("GET /api/users/:handle/posts?cursor=garbage -> 400", api("GET", f"/api/users/{handle_a}/posts?cursor=zz").status_code == 400)
        check("profile postCount counts active posts (C = 7)", api("GET", f"/api/users/{api('GET', '/api/me', tok_c).json()['handle']}").json()["postCount"] == 7)

        # ================= prices via post =================
        print("-- prices via post")
        check("GET /api/posts/:id/prices unknown -> 404", api("GET", "/api/posts/999999/prices").status_code == 404)
        r = api("GET", f"/api/posts/{post_id}/prices", ip="10.1.1.1")
        pp = r.json() if r.status_code == 200 else {}
        check("GET /api/posts/:id/prices anonymous -> 200 {postId, items[].offers}", r.status_code == 200 and pp.get("postId") == post_id and isinstance(pp.get("items"), list) and len(pp["items"]) == 1 and isinstance(pp["items"][0].get("offers"), list), r.text[:200])
        offers = pp.get("items", [{}])[0].get("offers", [])
        check("post prices: offers come from the (mocked) provider, Amazon price hidden", len(offers) == 2 and any(o["seller"].lower().startswith("amazon") and o["price"] is None for o in offers), str(offers)[:300])
        check("post prices: shoppingQuery hinted from the OWNER's shopFor (women's)", pp["items"][0].get("shoppingQuery", "").startswith("women's "), pp["items"][0].get("shoppingQuery"))
        leak_check("GET /api/posts/:id/prices", pp, FORBIDDEN)
        # Shared pipeline: the daily budget is 1 and the post lookup spent it. The crew route must still get the
        # same offers (memo / price_cache hit) instead of an empty list from a budget refusal.
        r = api("GET", f"/api/picks/{pick['id']}/prices", tok_b)
        check("GET /api/picks/:id/prices (member) returns the identical items/offers -> same cache + budget", r.status_code == 200 and r.json()["items"] == pp["items"], f"{r.status_code} {r.text[:200]}")
        codes = [api("GET", f"/api/posts/{post_id}/prices", ip="10.2.2.2").status_code for _ in range(31)]
        check("post prices rate limit: 30/h/IP then 429", codes[:30] == [200] * 30 and codes[30] == 429, f"{codes.count(200)}x200 last={codes[-1]}")
        check("another IP is unaffected", api("GET", f"/api/posts/{post_id}/prices", ip="10.3.3.3").status_code == 200)

        # ================= report -> auto-hide =================
        print("-- report")
        target = made[0][0]  # B's post
        check("POST /api/posts/:id/report unknown -> 404", api("POST", "/api/posts/999999/report", json={"reason": "x"}).status_code == 404)
        check("POST report empty reason -> 400", api("POST", f"/api/posts/{target}/report", json={"reason": "  "}).status_code == 400)
        check("POST report reason > 200 -> 400", api("POST", f"/api/posts/{target}/report", json={"reason": "x" * 201}).status_code == 400)
        check("POST report own post (B) -> 400", api("POST", f"/api/posts/{target}/report", tok_b, json={"reason": "mine"}).status_code == 400)
        r = api("POST", f"/api/posts/{target}/report", ip="20.0.0.1", json={"reason": "spam"})
        check("anonymous report -> 201 {id, reportCount:1, hidden:false}", r.status_code == 201 and r.json().get("reportCount") == 1 and r.json().get("hidden") is False and isinstance(r.json().get("id"), int), r.text)
        check("report response Cache-Control: no-store", "no-store" in r.headers.get("Cache-Control", "").lower())
        r = api("POST", f"/api/posts/{target}/report", ip="20.0.0.1", json={"reason": "spam again"})
        check("same anonymous reporter (same IP) again -> still reportCount 1", r.status_code == 201 and r.json().get("reportCount") == 1, r.text)
        r = api("POST", f"/api/posts/{target}/report", tok_a, ip="20.0.0.2", json={"reason": "not an outfit"})
        check("signed-in report (A) -> reportCount 2", r.status_code == 201 and r.json().get("reportCount") == 2 and r.json().get("hidden") is False, r.text)
        r = api("POST", f"/api/posts/{target}/report", tok_a, ip="20.0.0.3", json={"reason": "dup"})
        check("same signed-in reporter from another IP -> still 2", r.json().get("reportCount") == 2, r.text)
        check("post still public after 2 distinct reports", api("GET", f"/api/posts/{target}").status_code == 200)
        r = api("POST", f"/api/posts/{target}/report", tok_c, ip="20.0.0.4", json={"reason": "third"})
        check("third distinct reporter (C) -> reportCount 3, hidden:true", r.status_code == 201 and r.json().get("reportCount") == 3 and r.json().get("hidden") is True, r.text)
        check("auto-hidden: GET /api/posts/:id anonymous -> 404", api("GET", f"/api/posts/{target}").status_code == 404)
        check("auto-hidden: GET as another user (A) -> 404", api("GET", f"/api/posts/{target}", tok_a).status_code == 404)
        g = api("GET", f"/api/posts/{target}", tok_b)
        check("auto-hidden: owner still sees it with status hidden", g.status_code == 200 and g.json()["status"] == "hidden", g.text[:200])
        g = api("GET", f"/api/posts/{target}", tok_adm)
        check("auto-hidden: admin sees it (status hidden, pickId filled)", g.status_code == 200 and g.json()["status"] == "hidden" and isinstance(g.json()["pickId"], int), g.text[:200])
        check("auto-hidden post is out of the feed", target not in {p["id"] for p in api("GET", "/api/discover").json()["posts"]} | {p["id"] for p in api("GET", f"/api/discover?cursor={api('GET', '/api/discover').json()['nextCursor']}").json()["posts"]})
        check("auto-hidden: like -> 404", api("POST", f"/api/posts/{target}/like", tok_a).status_code == 404)
        handle_b = api("GET", "/api/me", tok_b).json()["handle"]
        check("auto-hidden post not in the owner's public posts for others", target not in {p["id"] for p in api("GET", f"/api/users/{handle_b}/posts").json()["posts"]})
        check("auto-hidden post IS in the owner's posts for the owner (status hidden)", any(p["id"] == target and p["status"] == "hidden" for p in api("GET", f"/api/users/{handle_b}/posts", tok_b).json()["posts"]))
        check("profile postCount excludes hidden (B: 7)", api("GET", f"/api/users/{handle_b}").json()["postCount"] == 7)
        pick_of_target = g.json()["pickId"]
        r = api("POST", f"/api/picks/{pick_of_target}/share", tok_b, json={"vibe": "gym", "caption": "please come back"})
        check("owner re-share of a report-hidden post updates it but stays hidden (sticky)", r.status_code == 201 and r.json()["status"] == "hidden" and r.json()["caption"] == "please come back", r.text[:200])
        check("still 404 publicly", api("GET", f"/api/posts/{target}").status_code == 404)
        # 5/h/IP limit (fresh IP: 5 reports on different posts then 429)
        codes = [api("POST", f"/api/posts/{made[i + 1][0]}/report", ip="30.0.0.1", json={"reason": f"r{i}"}).status_code for i in range(6)]
        check("report rate limit: 5/h/IP then 429", codes[:5] == [201] * 5 and codes[5] == 429, str(codes))
        check("report rate limit counts even repeated reports? no - but a different IP still works", api("POST", f"/api/posts/{made[1][0]}/report", ip="30.0.0.2", json={"reason": "ok"}).status_code == 201)

        # ================= admin =================
        print("-- admin")
        for path, method, body in (("/api/admin/posts", "GET", None), ("/api/admin/reports", "GET", None), (f"/api/admin/posts/{target}", "PATCH", {"status": "active"})):
            check(f"{method} {path} without token -> 401", api(method, path, json=body).status_code == 401)
            check(f"{method} {path} as non-admin (A) -> 403", api(method, path, tok_a, json=body).status_code == 403)
        r = api("GET", "/api/admin/posts", tok_adm)
        allp = r.json()
        check("GET /api/admin/posts -> every post (active + hidden) with reportCount/statusReason/pickId", r.status_code == 200 and len(allp) == total_active and all("reportCount" in p and "statusReason" in p and isinstance(p["pickId"], int) for p in allp), f"{r.status_code} {len(allp) if isinstance(allp, list) else allp}")
        hidden_row = next((p for p in allp if p["id"] == target), None)
        check("admin list: the auto-hidden post shows status hidden, statusReason reports, reportCount 3", hidden_row and hidden_row["status"] == "hidden" and hidden_row["statusReason"] == "reports" and hidden_row["reportCount"] == 3, str(hidden_row)[:200])
        r = api("GET", "/api/admin/posts?status=hidden", tok_adm)
        check("GET /api/admin/posts?status=hidden -> only hidden", r.status_code == 200 and [p["id"] for p in r.json()] == [target], r.text[:200])
        check("GET /api/admin/posts?status=bogus -> 400", api("GET", "/api/admin/posts?status=bogus", tok_adm).status_code == 400)
        r = api("GET", "/api/admin/reports", tok_adm)
        reps = r.json()
        check("GET /api/admin/reports -> newest first with reporter card (null for anonymous), postStatus, postAuthorHandle",
              r.status_code == 200 and len(reps) >= 9 and all("reporter" in x and "postStatus" in x and "postAuthorHandle" in x and "reason" in x for x in reps)
              and any(x["reporter"] is None and x["postId"] == target for x in reps) and any(x["reporter"] and x["reporter"]["handle"] == handle_a and x["postId"] == target for x in reps)
              and all(x["postStatus"] == "hidden" for x in reps if x["postId"] == target), f"{r.status_code} {str(reps)[:300]}")
        check("admin reports: exactly 3 rows for the hidden post (distinct reporters)", sum(1 for x in reps if x["postId"] == target) == 3)
        check("PATCH /api/admin/posts/:id bad status -> 400", api("PATCH", f"/api/admin/posts/{target}", tok_adm, json={"status": "banana"}).status_code == 400)
        check("PATCH /api/admin/posts/:id unknown -> 404", api("PATCH", "/api/admin/posts/999999", tok_adm, json={"status": "active"}).status_code == 404)
        r = api("PATCH", f"/api/admin/posts/{target}", tok_adm, json={"status": "active"})
        check("PATCH admin -> active: 200 PostView status active, statusReason null", r.status_code == 200 and r.json()["status"] == "active" and r.json()["statusReason"] is None, r.text[:200])
        check("reactivated post is public again", api("GET", f"/api/posts/{target}").status_code == 200)
        r = api("PATCH", f"/api/admin/posts/{target}", tok_adm, json={"status": "removed"})
        check("PATCH admin -> removed", r.status_code == 200 and r.json()["status"] == "removed" and r.json()["statusReason"] == "admin")
        check("admin-removed: 404 publicly and for the owner's public list", api("GET", f"/api/posts/{target}").status_code == 404 and target not in {p["id"] for p in api("GET", f"/api/users/{handle_b}/posts", tok_b).json()["posts"]})
        r = api("POST", f"/api/picks/{pick_of_target}/share", tok_b, json={"vibe": "gym"})
        check("owner re-share after ADMIN removal stays removed (sticky)", r.status_code == 201 and r.json()["status"] == "removed", r.text[:200])
        r = api("GET", "/api/admin/posts?status=removed", tok_adm)
        check("GET /api/admin/posts?status=removed lists it", [p["id"] for p in r.json()] == [target])
        api("PATCH", f"/api/admin/posts/{target}", tok_adm, json={"status": "hidden"})
        check("PATCH admin -> hidden sets statusReason admin", api("GET", "/api/admin/posts?status=hidden", tok_adm).json()[0]["statusReason"] == "admin")
        # admin may delete someone else's post
        victim = made[1][0]
        r = api("DELETE", f"/api/posts/{victim}", tok_adm)
        check("DELETE /api/posts/:id by admin -> 200 removed", r.status_code == 200 and r.json()["status"] == "removed", r.text)
        check("admin-deleted post -> 404", api("GET", f"/api/posts/{victim}").status_code == 404)

        # ================= owner delete =================
        print("-- owner delete")
        mine = made[3][0]
        check("DELETE /api/posts/:id without token -> 401", api("DELETE", f"/api/posts/{mine}").status_code == 401)
        check("DELETE /api/posts/:id by non-owner (A) -> 403", api("DELETE", f"/api/posts/{mine}", tok_a).status_code == 403)
        check("DELETE unknown -> 404", api("DELETE", "/api/posts/999999", tok_b).status_code == 404)
        r = api("DELETE", f"/api/posts/{mine}", tok_b)
        check("DELETE by owner -> 200 {ok, status removed}", r.status_code == 200 and r.json().get("ok") is True and r.json().get("status") == "removed", r.text)
        check("deleted: GET -> 404 for everyone incl. the owner's public list; owner GET /api/posts/:id still sees status removed",
              api("GET", f"/api/posts/{mine}").status_code == 404 and api("GET", f"/api/posts/{mine}", tok_b).json().get("status") == "removed")
        check("DELETE again -> 404", api("DELETE", f"/api/posts/{mine}", tok_b).status_code == 404)
        check("deleted post out of the feed", mine not in {p["id"] for p in api("GET", "/api/discover").json()["posts"]})
        pick_mine = api("GET", f"/api/posts/{mine}", tok_b).json()["pickId"]
        r = api("POST", f"/api/picks/{pick_mine}/share", tok_b, json={"vibe": "gym", "caption": "back"})
        check("owner re-share after OWNER delete reactivates (same post id, status active)", r.status_code == 201 and r.json()["id"] == mine and r.json()["status"] == "active", r.text[:200])
        check("re-shared post is public again", api("GET", f"/api/posts/{mine}").status_code == 200)

        # ================= cascades: photo removal / re-post / pick deletion =================
        print("-- cascades")
        # A's post shows only photo_pub; removing that photo from the pick leaves the post with none -> hidden
        r = api("DELETE", f"/api/picks/{pick['id']}/photos/{photo_pub['id']}", tok_a)
        check("DELETE the post's only public photo from the pick -> 200", r.status_code == 200, r.text[:200])
        g = api("GET", f"/api/posts/{post_id}", tok_a)
        check("post now has photos [] and status hidden (owner view)", g.status_code == 200 and g.json()["photos"] == [] and g.json()["status"] == "hidden", g.text[:200])
        check("hidden-by-no-photos post -> 404 anonymously", api("GET", f"/api/posts/{post_id}").status_code == 404)
        hid = next(p for p in api("GET", "/api/admin/posts?status=hidden", tok_adm).json() if p["id"] == post_id)
        check("admin sees statusReason no_photos", hid["statusReason"] == "no_photos", str(hid)[:200])
        r = api("POST", f"/api/picks/{pick['id']}/share", tok_a, json={"vibe": "gym", "photoIds": [photo_priv["id"]]})
        check("re-share choosing the remaining photo -> active again with that photo", r.status_code == 201 and r.json()["status"] == "active" and [p["id"] for p in r.json()["photos"]] == [photo_priv["id"]], r.text[:200])
        # two public photos, remove one -> the other stays, post stays active
        r = api("POST", f"/api/picks/{pick['id']}/photos", tok_a, files=[("photo", ("n.jpg", JPEG, "image/jpeg"))])
        new_photo = r.json()["photos"][-1]
        uploaded.append(new_photo["url"])
        api("POST", f"/api/picks/{pick['id']}/share", tok_a, json={"vibe": "gym", "photoIds": [photo_priv["id"], new_photo["id"]]})
        api("DELETE", f"/api/picks/{pick['id']}/photos/{new_photo['id']}", tok_a)
        g = api("GET", f"/api/posts/{post_id}").json()
        check("removing one of two public photos keeps the post active with the other", g.get("status") == "active" and [p["id"] for p in g.get("photos", [])] == [photo_priv["id"]], str(g)[:200])
        # re-post (replace the whole pick) -> every chosen photo is gone -> hidden until re-shared
        pk2 = upload(sess["id"], tok_a, n_photos=1)
        check("re-post keeps the pick id", pk2["id"] == pick["id"])
        g = api("GET", f"/api/posts/{post_id}", tok_a).json()
        check("after a re-post the post is hidden with photos []", g.get("status") == "hidden" and g.get("photos") == [], str(g)[:200])
        r = api("POST", f"/api/picks/{pick['id']}/share", tok_a, json={"vibe": "gym"})
        check("re-share after re-post picks the new photos and reactivates", r.status_code == 201 and r.json()["status"] == "active" and [p["id"] for p in r.json()["photos"]] == [pk2["photos"][0]["id"]], r.text[:200])
        # pick deletion cascades the post
        r = api("DELETE", f"/api/picks/{pick['id']}", tok_a)
        check("DELETE /api/picks/:id -> 200", r.status_code == 200)
        check("post gone with the pick: 404 for owner and admin", api("GET", f"/api/posts/{post_id}", tok_a).status_code == 404 and api("GET", f"/api/posts/{post_id}", tok_adm).status_code == 404)
        check("post gone from the admin list", post_id not in {p["id"] for p in api("GET", "/api/admin/posts", tok_adm).json()})
        check("profile postCount back to 0 for A", api("GET", f"/api/users/{handle_a}").json()["postCount"] == 0)
        check("liking the vanished post -> 404", api("POST", f"/api/posts/{post_id}/like", tok_b).status_code == 404)

        # ================= final privacy sweep over everything public =================
        print("-- privacy sweep")
        everything = {
            "discover": api("GET", "/api/discover").json(),
            "discover top": api("GET", "/api/discover?sort=top").json(),
            "user posts b": api("GET", f"/api/users/{handle_b}/posts").json(),
            "profile b": api("GET", f"/api/users/{handle_b}").json(),
        }
        for label, payload in everything.items():
            leak_check(label, payload, {k: v for k, v in FORBIDDEN.items() if k not in ("private photo",)})
        blob = json.dumps(everything)
        check("privacy: no 'note', 'crewId', 'inviteCode', 'userId', 'locked' keys in any public payload", not any(f'"{k}"' in blob for k in ("note", "crewId", "inviteCode", "userId", "locked", "analysisError")))
        check("privacy: every author name is a single word (first name only)", all(" " not in p["author"]["name"] for p in everything["discover"]["posts"]))
        # server log sanity
        log.flush()
        logtxt = open(os.path.join(tmp, "server.log")).read()
        check("server log records the auto-hide", "auto-hidden after 3 distinct reports" in logtxt)
        check("server log has no unhandled Internal Server Error", "Internal Server Error" not in logtxt, logtxt[-600:])
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), 15)
        except Exception:  # noqa: BLE001
            proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            proc.kill()
        log.close()
        for u in uploaded:
            try:
                p = os.path.join(ROOT, u.lstrip("/"))
                if u.startswith("/uploads/") and os.path.exists(p):
                    os.remove(p)
            except OSError:
                pass
        shutil.rmtree(tmp, ignore_errors=True)

    npass = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{npass}/{len(RESULTS)} checks passed")
    for name, ok, detail in RESULTS:
        if not ok:
            print(f"  FAIL {name} -> {detail}")
    return 0 if npass == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
