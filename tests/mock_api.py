#!/usr/bin/env python3
"""
Tiny stdlib-only mock of the MMV API contract, used ONLY to sanity-check tests/smoke.py
when no real server is available:

    python tests/mock_api.py 5999 &
    python tests/smoke.py --base http://localhost:5999

It mirrors server/routes.ts status codes (401/400/404/409/429), magic-byte sniffing,
the 6-attempt login limiter and the upsert-one-pick-per-user behaviour. It does NOT
call Gemini: every pick returns analysisFailed=true with empty items.
"""
import json
import re
import secrets
import sys
import time
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = {"users": {}, "tokens": {}, "crews": {}, "sessions": {}, "picks": {}, "reactions": [], "files": {}}
SEQ = {"u": 0, "c": 0, "s": 0, "p": 0}
LOGIN_ATTEMPTS = {}


def nid(k):
    SEQ[k] += 1
    return SEQ[k]


def pub(u):
    return {k: v for k, v in u.items() if k not in ("pin", "token")}


def pick_view(p):
    v = dict(p)
    v["user"] = pub(DB["users"][p["userId"]])
    v["reactions"] = [dict(r, user=pub(DB["users"][r["userId"]])) for r in DB["reactions"] if r["pickId"] == p["id"]]
    return v


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

    def send(self, code, body=None, ctype="application/json", raw=None):
        data = raw if raw is not None else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
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
        u = self.user()
        if not u:
            return self.send(401, {"message": "Sign in first"})
        if p == "/api/me":
            return self.send(200, pub(u))
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
            return self.send(200, session_view(s))
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
            u = {"id": nid("u"), "name": name, "handle": h.lower(), "pin": pin, "color": "#ff00aa", "token": secrets.token_hex(16)}
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
        if not u:
            return self.send(401, {"message": "Sign in first"})
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
            if not ctype.startswith("multipart/form-data"):
                return self.send(400, {"message": "Add a photo of the outfit"})
            msg = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
            photo, note = None, None
            for part in msg.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if name == "photo":
                    if not re.match(r"image/(jpeg|png|webp|heic|heif|gif)", part.get_content_type() or ""):
                        return self.send(400, {"message": "Please upload a photo (JPG, PNG, HEIC or WebP)"})
                    photo = part.get_payload(decode=True)
                elif name == "note":
                    note = part.get_payload(decode=True).decode()
            if photo is None:
                return self.send(400, {"message": "Add a photo of the outfit"})
            kind = sniff(photo)
            if not kind:
                return self.send(400, {"message": "That file isn't a photo we can read"})
            path = f"/uploads/{int(time.time()*1000)}-{secrets.token_hex(8)}{kind[0]}"
            DB["files"][path] = photo
            old = next((x for x in DB["picks"].values() if x["sessionId"] == s["id"] and x["userId"] == u["id"]), None)
            if old:
                DB["files"].pop(old["photoPath"], None)
                old.update(photoPath=path, note=note)
                pk = old
            else:
                pk = {"id": nid("p"), "sessionId": s["id"], "userId": u["id"], "photoPath": path, "note": note, "palette": [], "items": [], "locked": False, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ")}
                DB["picks"][pk["id"]] = pk
            return self.send(200, dict(pick_view(pk), analysisFailed=True))
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
        m = re.fullmatch(r"/api/picks/(\d+)", self.path)
        if m:
            pk = DB["picks"].get(int(m[1]))
            if not pk or pk["userId"] != u["id"]:
                return self.send(404, {"message": "Pick not found"})
            DB["picks"].pop(pk["id"])
            DB["files"].pop(pk["photoPath"], None)
            return self.send(200, {"ok": True})
        self.send(404, {"message": "nope"})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5999
    print(f"mock MMV API on http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
