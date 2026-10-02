#!/usr/bin/env python3
"""
Tiny stdlib-only mock of the MMV API contract, used ONLY to sanity-check tests/smoke.py
when no real server is available:

    python tests/mock_api.py 5999 &
    python tests/smoke.py --base http://localhost:5999

It mirrors server/routes.ts status codes (401/400/404/409/429), magic-byte sniffing,
the 6-attempt login limiter and the upsert-one-pick-per-user behaviour, plus the async
analysis contract: POST picks -> 201 with analysisStatus "pending"; the first GET /api/picks/:id
afterwards flips it to "failed" (no Gemini here: analysisError set, analysisFailed=true, items []).
POST /api/picks/:id/analyze (owner only, 403 otherwise) re-queues the same way.
Multi-photo picks: 1..6 files under `photo` -> photos[] (position order); pick-level status/items are aggregates;
POST /api/picks/:id/photos, DELETE /api/picks/:id/photos/:photoId (last -> 400), POST .../photos/:photoId/analyze.
Discover (public): POST /api/picks/:id/share, GET /api/discover, GET /api/posts/:id(/prices), POST .../like, .../report,
GET /api/users/:handle(/posts), POST .../follow, PATCH /api/me {bio}, DELETE /api/posts/:id; admin routes always 403.
"""
import json
import re
import secrets
import sys
import time
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SHOP_FOR = ("womens", "mens", "unisex")
DB = {"users": {}, "tokens": {}, "crews": {}, "sessions": {}, "picks": {}, "reactions": [], "files": {},
      "posts": {}, "likes": set(), "follows": set(), "reports": {}}
SEQ = {"u": 0, "c": 0, "s": 0, "p": 0, "ph": 0, "po": 0, "rp": 0}
VIBES = ("gym", "run", "pickleball", "golf", "date-night", "girls-night", "guys-night", "brunch", "travel", "other")
MAX_PHOTOS = 6
LOGIN_ATTEMPTS = {}


def nid(k):
    SEQ[k] += 1
    return SEQ[k]


def pub(u):
    return {k: v for k, v in u.items() if k not in ("pin", "token")}


def first_name(u):
    return (u["name"].strip().split() or [u["handle"]])[0]


def post_view(po, viewer):
    pk = DB["picks"][po["pickId"]]
    aggregate(pk)
    author = DB["users"][po["userId"]]
    mine = bool(viewer) and viewer["id"] == po["userId"]
    return {"id": po["id"], "caption": po["caption"], "vibe": po["vibe"], "createdAt": po["createdAt"], "likeCount": po["likeCount"],
            "likedByMe": bool(viewer) and (po["id"], viewer["id"]) in DB["likes"],
            "photos": [{"id": x["id"], "url": x["path"]} for x in sorted(pk["photos"], key=lambda x: x["position"]) if x["id"] in po["photoIds"]],
            "items": [dict(i, shoppingQuery=i.get("searchQuery", "")) for i in pk["items"]], "palette": pk["palette"], "analysisStatus": pk["analysisStatus"],
            "author": {"id": author["id"], "name": first_name(author), "handle": author["handle"], "color": author["color"],
                       "isFollowedByMe": bool(viewer) and (viewer["id"], author["id"]) in DB["follows"]},
            "isMine": mine, "status": po["status"], "pickId": po["pickId"] if mine else None}


def profile(u, viewer):
    return {"id": u["id"], "name": first_name(u), "handle": u["handle"], "color": u["color"], "bio": u.get("bio"),
            "followerCount": sum(1 for a, b in DB["follows"] if b == u["id"]), "followingCount": sum(1 for a, b in DB["follows"] if a == u["id"]),
            "postCount": sum(1 for p in DB["posts"].values() if p["userId"] == u["id"] and p["status"] == "active"),
            "isFollowedByMe": bool(viewer) and (viewer["id"], u["id"]) in DB["follows"], "isMe": bool(viewer) and viewer["id"] == u["id"]}


def new_photo(path, position):
    return {"id": nid("ph"), "path": path, "position": position, "analysisStatus": "pending", "analysisError": None, "items": [], "palette": [], "analyzedAt": None}


def aggregate(p):
    """Mirror server/aggregate.ts: status pending > ready > failed; error = first failed when none ready; cover = photo 0."""
    photos = sorted(p["photos"], key=lambda x: x["position"])
    st = [x["analysisStatus"] for x in photos]
    p["analysisStatus"] = "pending" if "pending" in st else "ready" if "ready" in st else "failed"
    failed = next((x for x in photos if x["analysisStatus"] == "failed"), None)
    p["analysisError"] = failed["analysisError"] if (failed and "ready" not in st) else None
    p["items"] = [i for x in photos for i in x["items"]][:12]
    p["palette"] = list(dict.fromkeys(h for x in photos for h in x["palette"]))[:6]
    p["analyzedAt"] = max([x["analyzedAt"] for x in photos if x["analyzedAt"]] or [None])
    p["photoPath"] = photos[0]["path"] if photos else p.get("photoPath")
    return p


def pick_view(p):
    aggregate(p)
    v = {k: val for k, val in p.items() if k != "photos"}
    v["analysisFailed"] = p.get("analysisStatus") == "failed"
    v["user"] = pub(DB["users"][p["userId"]])
    v["reactions"] = [dict(r, user=pub(DB["users"][r["userId"]])) for r in DB["reactions"] if r["pickId"] == p["id"]]
    v["photos"] = [{"id": x["id"], "url": x["path"], "position": x["position"], "analysisStatus": x["analysisStatus"],
                    "analysisError": x["analysisError"], "itemCount": len(x["items"])} for x in sorted(p["photos"], key=lambda x: x["position"])]
    return v


def settle_analysis(p):
    """Simulate the background jobs finishing: the mock has no vision, so every pending photo -> failed."""
    for ph in p["photos"]:
        if ph["analysisStatus"] == "pending":
            ph["analysisStatus"] = "failed"
            ph["analysisError"] = "vision unavailable in mock_api"
            ph["analyzedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ")
    return p


def parse_photos(ctype, raw):
    """-> (photos: list[bytes], note, error_message). Mirrors multer field filter + magic-byte sniff; > MAX_PHOTOS -> error."""
    if not ctype.startswith("multipart/form-data"):
        return [], None, "Add a photo of the outfit"
    msg = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
    photos, note = [], None
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name == "photo":
            if not re.match(r"image/(jpeg|png|webp|heic|heif|gif)", part.get_content_type() or ""):
                return [], None, "Please upload a photo (JPG, PNG, HEIC or WebP)"
            photos.append(part.get_payload(decode=True))
            if len(photos) > MAX_PHOTOS:
                return [], None, f"Up to {MAX_PHOTOS} photos per pick"
        elif name == "note":
            note = part.get_payload(decode=True).decode()
    if not photos:
        return [], None, "Add a photo of the outfit"
    if any(sniff(b) is None for b in photos):
        return [], None, "That file isn't a photo we can read"
    return photos, note, None


def store(photo):
    path = f"/uploads/{int(time.time()*1000)}-{secrets.token_hex(8)}{sniff(photo)[0]}"
    DB["files"][path] = photo
    return path


def session_view(s):
    crew = DB["crews"][s["crewId"]]
    v = dict(s)
    v["crew"] = {k: crew[k] for k in ("id", "name", "activity", "inviteCode", "createdBy")}
    v["members"] = [pub(DB["users"][u]) for u in crew["members"]]
    v["picks"] = [pick_view(p) for p in DB["picks"].values() if p["sessionId"] == s["id"]]
    return v


def crew_view(c):
    v = {k: c[k] for k in ("id", "name", "activity", "inviteCode", "createdBy")}
    v["members"] = [pub(DB["users"][u]) for u in c["members"]]
    v["nextSession"] = None
    return v


def sniff(b):
    if b[:3] == b"\xff\xd8\xff":
        return ".jpg", "image/jpeg"
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png", "image/png"
    return None


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code, body=None, ctype="application/json", raw=None, extra=None):
        data = raw if raw is not None else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def user(self):
        t = self.headers.get("x-auth-token")
        uid = DB["tokens"].get(t)
        return DB["users"].get(uid) if uid else None

    def do_GET(self):
        p = self.path
        if p == "/api/health":
            return self.send(200, {"ok": True})
        if p.startswith("/uploads/"):
            f = DB["files"].get(p)
            return self.send(200, raw=f, ctype="image/jpeg") if f else self.send(404, raw=b"")
        viewer = self.user()
        path, _, qs = p.partition("?")
        q = dict(x.split("=", 1) for x in qs.split("&") if "=" in x)
        if path == "/api/discover":
            if q.get("sort", "new") not in ("new", "top") or ("vibe" in q and q["vibe"] not in VIBES) or ("cursor" in q and q["cursor"]):
                return self.send(400, {"message": "Bad query"})
            rows = [x for x in DB["posts"].values() if x["status"] == "active" and (not q.get("vibe") or x["vibe"] == q["vibe"])]
            rows.sort(key=lambda x: ((-x["likeCount"],) if q.get("sort") == "top" else ()) + (x["createdAt"], x["id"]), reverse=q.get("sort") != "top")
            return self.send(200, {"posts": [post_view(x, viewer) for x in rows[:12]], "nextCursor": None}, extra={"Cache-Control": "no-store"})
        m = re.fullmatch(r"/api/posts/(\d+)(/prices)?", path)
        if m:
            po = DB["posts"].get(int(m[1]))
            if not po or (po["status"] != "active" and not (viewer and viewer["id"] == po["userId"])):
                return self.send(404, {"message": "Post not found"})
            if m[2]:
                return self.send(200, {"postId": po["id"], "items": [dict(i, offers=[]) for i in post_view(po, viewer)["items"]]})
            return self.send(200, post_view(po, viewer), extra={"Cache-Control": "no-store"})
        m = re.fullmatch(r"/api/users/@?([A-Za-z0-9_]+)(/posts)?", path)
        if m:
            target = next((x for x in DB["users"].values() if x["handle"] == m[1].lower()), None)
            if not target:
                return self.send(404, {"message": "No one with that handle"})
            if m[2]:
                rows = sorted([x for x in DB["posts"].values() if x["userId"] == target["id"] and x["status"] == "active"], key=lambda x: x["id"], reverse=True)
                return self.send(200, {"posts": [post_view(x, viewer) for x in rows[:12]], "nextCursor": None}, extra={"Cache-Control": "no-store"})
            return self.send(200, profile(target, viewer), extra={"Cache-Control": "no-store"})
        u = viewer
        if not u:
            return self.send(401, {"message": "Sign in first"})
        if path.startswith("/api/admin/"):
            return self.send(403, {"message": "Admins only"})
        if p == "/api/me":
            pr = profile(u, u)
            return self.send(200, dict(pub(u), isAdmin=False, postCount=pr["postCount"], followerCount=pr["followerCount"], followingCount=pr["followingCount"]))
        if p == "/api/crews":
            return self.send(200, [crew_view(c) for c in DB["crews"].values() if u["id"] in c["members"]])
        m = re.fullmatch(r"/api/crews/(\d+)", p)
        if m:
            c = DB["crews"].get(int(m[1]))
            if not c or u["id"] not in c["members"]:
                return self.send(404, {"message": "Crew not found"})
            return self.send(200, dict(crew_view(c), sessions=[s for s in DB["sessions"].values() if s["crewId"] == c["id"]]))
        m = re.fullmatch(r"/api/crews/(\d+)/day/([^/]+)", p)
        if m:
            c = DB["crews"].get(int(m[1]))
            if not c or u["id"] not in c["members"]:
                return self.send(404, {"message": "Crew not found"})
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", m[2]):
                return self.send(400, {"message": "Bad date"})
            s = next((s for s in DB["sessions"].values() if s["crewId"] == c["id"] and s["date"] == m[2]), None)
            if not s:
                s = {"id": nid("s"), "crewId": c["id"], "title": "Today", "date": m[2], "vibe": None, "createdBy": u["id"]}
                DB["sessions"][s["id"]] = s
            return self.send(200, session_view(s))
        m = re.fullmatch(r"/api/sessions/(\d+)", p)
        if m:
            s = DB["sessions"].get(int(m[1]))
            if not s or u["id"] not in DB["crews"][s["crewId"]]["members"]:
                return self.send(404, {"message": "Session not found"})
            return self.send(200, session_view(s), extra={"Cache-Control": "no-store"})
        m = re.fullmatch(r"/api/picks/(\d+)", p)
        if m:
            pk = DB["picks"].get(int(m[1]))
            if not pk:
                return self.send(404, {"message": "Pick not found"})
            s = DB["sessions"][pk["sessionId"]]
            if u["id"] not in DB["crews"][s["crewId"]]["members"]:
                return self.send(403, {"message": "Not your crew"})
            return self.send(200, pick_view(settle_analysis(pk)), extra={"Cache-Control": "no-store"})
        m = re.fullmatch(r"/api/picks/(\d+)/prices", p)
        if m:
            pk = DB["picks"].get(int(m[1]))
            if not pk:
                return self.send(404, {"message": "Pick not found"})
            s = DB["sessions"][pk["sessionId"]]
            if u["id"] not in DB["crews"][s["crewId"]]["members"]:
                return self.send(403, {"message": "Not your crew"})
            items = [dict(i, shoppingQuery=i.get("searchQuery", ""), offers=[]) for i in pk["items"]]
            return self.send(200, {"pickId": pk["id"], "items": items})
        if p == "/api/closet":
            return self.send(200, [pick_view(x) for x in DB["picks"].values() if x["userId"] == u["id"]])
        self.send(404, {"message": "nope"})

    def do_POST(self):
        p = self.path
        raw = self.body()
        ctype = self.headers.get("Content-Type", "")
        js = {}
        if ctype.startswith("application/json"):
            try:
                js = json.loads(raw or b"{}")
            except Exception:
                return self.send(400, {"message": "bad json"})
        if p == "/api/auth/signup":
            h, pin, name = js.get("handle", ""), js.get("pin", ""), js.get("name", "")
            if not (isinstance(h, str) and re.fullmatch(r"[a-z0-9_]{2,20}", h, re.I) and re.fullmatch(r"\d{4}", str(pin)) and name):
                return self.send(400, {"message": "Invalid"})
            if any(x["handle"].lower() == h.lower() for x in DB["users"].values()):
                return self.send(409, {"message": "That handle is taken"})
            sf = js.get("shopFor")
            if sf is not None and sf not in SHOP_FOR:
                return self.send(400, {"message": "shopFor must be womens, mens or unisex"})
            u = {"id": nid("u"), "name": name, "handle": h.lower(), "pin": pin, "color": "#ff00aa", "token": secrets.token_hex(16), "shopFor": sf, "bio": None}
            DB["users"][u["id"]] = u
            DB["tokens"][u["token"]] = u["id"]
            return self.send(200, {"token": u["token"], "user": pub(u)})
        if p == "/api/auth/login":
            h, pin = str(js.get("handle", "")), str(js.get("pin", ""))
            if not (re.fullmatch(r"[a-z0-9_]{2,20}", h, re.I) and re.fullmatch(r"\d{4}", pin)):
                return self.send(400, {"message": "Invalid"})
            now = time.time()
            arr = [t for t in LOGIN_ATTEMPTS.get(h.lower(), []) if now - t < 900]
            if len(arr) >= 6:
                LOGIN_ATTEMPTS[h.lower()] = arr
                return self.send(429, {"message": "Too many attempts."})
            arr.append(now)
            LOGIN_ATTEMPTS[h.lower()] = arr
            u = next((x for x in DB["users"].values() if x["handle"] == h.lower()), None)
            if not u or u["pin"] != pin:
                return self.send(401, {"message": "Wrong handle or PIN"})
            return self.send(200, {"token": u["token"], "user": pub(u)})
        u = self.user()
        m = re.fullmatch(r"/api/posts/(\d+)/report", p)
        if m:
            po = DB["posts"].get(int(m[1]))
            if not po or po["status"] == "removed":
                return self.send(404, {"message": "Post not found"})
            reason = str(js.get("reason") or "").strip()
            if not reason or len(reason) > 200:
                return self.send(400, {"message": "Tell us what's wrong with this post"})
            if u and u["id"] == po["userId"]:
                return self.send(400, {"message": "You can't report your own post"})
            key = f"u:{u['id']}" if u else f"ip:{self.client_address[0]}"
            DB["reports"].setdefault(po["id"], {})[key] = reason
            n = len(DB["reports"][po["id"]])
            if n >= 3 and po["status"] == "active":
                po["status"] = "hidden"
            return self.send(201, {"id": nid("rp"), "reportCount": n, "hidden": po["status"] == "hidden"}, extra={"Cache-Control": "no-store"})
        if not u:
            return self.send(401, {"message": "Sign in first"})
        if p.startswith("/api/admin/"):
            return self.send(403, {"message": "Admins only"})
        m = re.fullmatch(r"/api/picks/(\d+)/share", p)
        if m:
            pk = DB["picks"].get(int(m[1]))
            if not pk:
                return self.send(404, {"message": "Pick not found"})
            if pk["userId"] != u["id"]:
                return self.send(403, {"message": "Only the owner can share this pick"})
            if js.get("vibe") not in VIBES or len(str(js.get("caption") or "")) > 140:
                return self.send(400, {"message": "Invalid"})
            ids = [x["id"] for x in pk["photos"]]
            chosen = js.get("photoIds")
            if chosen is not None and (not chosen or any(i not in ids for i in chosen)):
                return self.send(400, {"message": "photoIds must be photos of this pick"})
            po = next((x for x in DB["posts"].values() if x["pickId"] == pk["id"]), None)
            if not po:
                po = {"id": nid("po"), "pickId": pk["id"], "userId": u["id"], "likeCount": 0, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "photoIds": ids}
                DB["posts"][po["id"]] = po
            po.update(caption=(str(js.get("caption") or "").strip() or None), vibe=js["vibe"], status="active", photoIds=chosen or po["photoIds"] or ids)
            return self.send(201, post_view(po, u), extra={"Cache-Control": "no-store"})
        m = re.fullmatch(r"/api/posts/(\d+)/like", p)
        if m:
            po = DB["posts"].get(int(m[1]))
            if not po or po["status"] != "active":
                return self.send(404, {"message": "Post not found"})
            key = (po["id"], u["id"])
            liked = key not in DB["likes"]
            (DB["likes"].add if liked else DB["likes"].discard)(key)
            po["likeCount"] = sum(1 for k in DB["likes"] if k[0] == po["id"])
            return self.send(200, {"likeCount": po["likeCount"], "likedByMe": liked})
        m = re.fullmatch(r"/api/users/@?([A-Za-z0-9_]+)/follow", p)
        if m:
            target = next((x for x in DB["users"].values() if x["handle"] == m[1].lower()), None)
            if not target:
                return self.send(404, {"message": "No one with that handle"})
            if target["id"] == u["id"]:
                return self.send(400, {"message": "You can't follow yourself"})
            key = (u["id"], target["id"])
            following = key not in DB["follows"]
            (DB["follows"].add if following else DB["follows"].discard)(key)
            return self.send(200, {"following": following, "followerCount": sum(1 for a, b in DB["follows"] if b == target["id"])})
        if p == "/api/crews":
            if not js.get("name") or js.get("activity") not in ("Gym", "CrossFit", "Run club", "Brunch", "Other", "Date night"):
                return self.send(400, {"message": "Give the crew a name and an activity"})
            c = {"id": nid("c"), "name": js["name"], "activity": js["activity"], "inviteCode": secrets.token_hex(3).upper(), "createdBy": u["id"], "members": [u["id"]]}
            DB["crews"][c["id"]] = c
            return self.send(200, crew_view(c))
        if p == "/api/crews/join":
            code = str(js.get("inviteCode", "")).strip()
            if not (4 <= len(code) <= 10):
                return self.send(400, {"message": "Enter an invite code"})
            c = next((c for c in DB["crews"].values() if c["inviteCode"] == code), None)
            if not c:
                return self.send(404, {"message": "No crew with that code"})
            if u["id"] not in c["members"]:
                c["members"].append(u["id"])
            return self.send(200, crew_view(c))
        m = re.fullmatch(r"/api/sessions/(\d+)/picks", p)
        if m:
            s = DB["sessions"].get(int(m[1]))
            if not s or u["id"] not in DB["crews"][s["crewId"]]["members"]:
                return self.send(404, {"message": "Session not found"})
            photos, note, err = parse_photos(ctype, raw)
            if err:
                return self.send(400, {"message": err})
            paths = [store(b) for b in photos]
            old = next((x for x in DB["picks"].values() if x["sessionId"] == s["id"] and x["userId"] == u["id"]), None)
            fresh = {"photoPath": paths[0], "note": note, "palette": [], "items": [], "locked": False, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                     "analysisStatus": "pending", "analysisError": None, "analyzedAt": None, "photos": [new_photo(pa, i) for i, pa in enumerate(paths)]}
            if old:
                for ph in old["photos"]:
                    DB["files"].pop(ph["path"], None)
                DB["reactions"] = [r for r in DB["reactions"] if r["pickId"] != old["id"]]
                old.update(fresh)
                pk = old
            else:
                pk = dict(fresh, id=nid("p"), sessionId=s["id"], userId=u["id"])
                DB["picks"][pk["id"]] = pk
            return self.send(201, pick_view(pk), extra={"Cache-Control": "no-store"})
        m = re.fullmatch(r"/api/picks/(\d+)/analyze", p)
        if m:
            pk = DB["picks"].get(int(m[1]))
            if not pk:
                return self.send(404, {"message": "Pick not found"})
            if pk["userId"] != u["id"]:
                return self.send(403, {"message": "Only the owner can re-run the analysis"})
            if any(ph["analysisStatus"] == "pending" for ph in pk["photos"]):
                return self.send(202, pick_view(pk), extra={"Cache-Control": "no-store"})
            failed = [ph for ph in pk["photos"] if ph["analysisStatus"] == "failed"]
            for ph in failed or pk["photos"]:
                ph.update(analysisStatus="pending", analysisError=None)
            return self.send(200, pick_view(pk), extra={"Cache-Control": "no-store"})
        m = re.fullmatch(r"/api/picks/(\d+)/photos", p)
        if m:
            pk = DB["picks"].get(int(m[1]))
            if not pk:
                return self.send(404, {"message": "Pick not found"})
            if pk["userId"] != u["id"]:
                return self.send(403, {"message": "Only the owner can change this pick"})
            photos, _note, err = parse_photos(ctype, raw)
            if err:
                return self.send(400, {"message": err.replace("of the outfit", "")})
            if len(pk["photos"]) + len(photos) > MAX_PHOTOS:
                return self.send(400, {"message": f"Up to {MAX_PHOTOS} photos per pick (you have {len(pk['photos'])})", "max": MAX_PHOTOS, "current": len(pk["photos"])})
            start = max([ph["position"] for ph in pk["photos"]] + [-1]) + 1
            pk["photos"] += [new_photo(store(b), start + i) for i, b in enumerate(photos)]
            return self.send(201, pick_view(pk), extra={"Cache-Control": "no-store"})
        m = re.fullmatch(r"/api/picks/(\d+)/photos/(\d+)/analyze", p)
        if m:
            pk = DB["picks"].get(int(m[1]))
            if not pk:
                return self.send(404, {"message": "Pick not found"})
            if pk["userId"] != u["id"]:
                return self.send(403, {"message": "Only the owner can change this pick"})
            ph = next((x for x in pk["photos"] if x["id"] == int(m[2])), None)
            if not ph:
                return self.send(404, {"message": "Photo not found"})
            if ph["analysisStatus"] == "pending":
                return self.send(202, pick_view(pk), extra={"Cache-Control": "no-store"})
            ph.update(analysisStatus="pending", analysisError=None)
            return self.send(200, pick_view(pk), extra={"Cache-Control": "no-store"})
        m = re.fullmatch(r"/api/picks/(\d+)/reactions", p)
        if m:
            pk = DB["picks"].get(int(m[1]))
            if not pk:
                return self.send(404, {"message": "Pick not found"})
            e, c = js.get("emoji"), js.get("comment")
            if not e and not c:
                return self.send(400, {"message": "Invalid"})
            DB["reactions"].append({"id": len(DB["reactions"]) + 1, "pickId": pk["id"], "userId": u["id"], "emoji": e, "comment": c})
            return self.send(200, pick_view(pk))
        self.send(404, {"message": "nope"})

    def do_PATCH(self):
        p = self.path
        try:
            js = json.loads(self.body() or b"{}")
        except Exception:
            return self.send(400, {"message": "Invalid"})
        u = self.user()
        if not u:
            return self.send(401, {"message": "Sign in first"})
        if p.startswith("/api/admin/"):
            return self.send(403, {"message": "Admins only"})
        if p == "/api/me":
            if "shopFor" not in js and "bio" not in js:
                return self.send(400, {"message": "Send shopFor and/or bio"})
            if "shopFor" in js and js["shopFor"] is not None and js["shopFor"] not in SHOP_FOR:
                return self.send(400, {"message": "shopFor must be womens, mens or unisex"})
            if "bio" in js and js["bio"] is not None and len(str(js["bio"]).strip()) > 120:
                return self.send(400, {"message": "Keep the bio under 120 characters"})
            if "shopFor" in js:
                u["shopFor"] = js["shopFor"]
            if "bio" in js:
                u["bio"] = (str(js["bio"]).strip() or None) if js["bio"] is not None else None
            return self.send(200, pub(u))
        m = re.fullmatch(r"/api/sessions/(\d+)", p)
        if m:
            s = DB["sessions"].get(int(m[1]))
            if not s or u["id"] not in DB["crews"][s["crewId"]]["members"]:
                return self.send(404, {"message": "Session not found"})
            if "vibe" in js:
                s["vibe"] = (js["vibe"] or "").strip() or None
            return self.send(200, session_view(s))
        m = re.fullmatch(r"/api/picks/(\d+)", p)
        if m:
            pk = DB["picks"].get(int(m[1]))
            if not pk or pk["userId"] != u["id"]:
                return self.send(404, {"message": "Pick not found"})
            if not isinstance(js.get("locked"), bool):
                return self.send(400, {"message": "Invalid"})
            pk["locked"] = js["locked"]
            return self.send(200, pick_view(pk))
        self.send(404, {"message": "nope"})

    def do_DELETE(self):
        self.body()
        u = self.user()
        if not u:
            return self.send(401, {"message": "Sign in first"})
        m = re.fullmatch(r"/api/posts/(\d+)", self.path)
        if m:
            po = DB["posts"].get(int(m[1]))
            if not po or po["status"] == "removed":
                return self.send(404, {"message": "Post not found"})
            if po["userId"] != u["id"]:
                return self.send(403, {"message": "Only the owner can remove this post"})
            po["status"] = "removed"
            return self.send(200, {"ok": True, "id": po["id"], "status": "removed"})
        m = re.fullmatch(r"/api/picks/(\d+)", self.path)
        if m:
            pk = DB["picks"].get(int(m[1]))
            if not pk or pk["userId"] != u["id"]:
                return self.send(404, {"message": "Pick not found"})
            DB["picks"].pop(pk["id"])
            for po in [x for x in DB["posts"].values() if x["pickId"] == pk["id"]]:
                DB["posts"].pop(po["id"])
            for ph in pk["photos"]:
                DB["files"].pop(ph["path"], None)
            return self.send(200, {"ok": True})
        m = re.fullmatch(r"/api/picks/(\d+)/photos/(\d+)", self.path)
        if m:
            pk = DB["picks"].get(int(m[1]))
            if not pk:
                return self.send(404, {"message": "Pick not found"})
            if pk["userId"] != u["id"]:
                return self.send(403, {"message": "Only the owner can change this pick"})
            ph = next((x for x in pk["photos"] if x["id"] == int(m[2])), None)
            if not ph:
                return self.send(404, {"message": "Photo not found"})
            if len(pk["photos"]) <= 1:
                return self.send(400, {"message": "A pick needs at least one photo - delete the pick instead"})
            pk["photos"].remove(ph)
            DB["files"].pop(ph["path"], None)
            for i, x in enumerate(sorted(pk["photos"], key=lambda x: x["position"])):
                x["position"] = i
            return self.send(200, pick_view(pk), extra={"Cache-Control": "no-store"})
        self.send(404, {"message": "nope"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5999
    print(f"mock MMV API on http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
