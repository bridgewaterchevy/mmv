#!/usr/bin/env python3
"""
Offline test for "Report a problem" (server/feedback.ts, server/github.ts).
No GitHub token, no network: this script runs a tiny mock of api.github.com on localhost and points the
code at it through MOCK_GITHUB_ISSUES_URL; the canned MOCK_GITHUB_ISSUE_JSON hook is exercised too.

    python tests/test_feedback_mock.py          # from the repo root; needs node_modules + `requests`

Part 1 runs tests/feedback_harness.ts (one Node process) and asserts:
  issue title ("[Report] " + first 60 chars; "[Idea] " for kind=suggestion), markdown body (message,
  reporter name/@handle/id, page, user agent, app version, last error in a code block, screenshot link only
  when public, timestamp; suggestions use "## The idea" and omit "## Last error" unless one was captured),
  request headers (Bearer token, Accept, API version, User-Agent), labels ["user-report"] (problem) /
  ["suggestion"] (suggestion) sent first and the retry WITHOUT labels when GitHub rejects them, failures (500 / 401 / unreachable / no html_url /
  canned 503) resolving to url=null without throwing, "not configured" short-circuit, ADMIN_HANDLES parsing,
  and that the token never appears in the harness output.
Part 2 boots the real server on a spare port (throwaway pglite dir, local ./uploads) with the mock and
  ADMIN_HANDLES set, then checks: /api/me isAdmin, POST /api/feedback JSON -> {id, kind, githubIssueUrl} and the
  issue body the mock received, kind defaults to "problem", kind=suggestion -> "[Idea]" title / "suggestion"
  label / "The idea" heading, invalid kind -> 400, shared 5/hour limit across kinds, GET ?kind= filter, multipart with a PNG screenshot (stored at /uploads/feedback/<id>.png,
  linked in the issue via APP_URL), magic-byte sniff / size / validation 400s, GitHub failure -> report
  still saved with githubIssueUrl null, label retry end to end, 5/hour/user 429, admin gating
  (401 / 403 / 200 list with user {name, handle}), PATCH status (400 / 404 / 200) reflected in the list.
Exit code 0 only if everything passes.
"""
import io
import json
import os
import random
import shutil
import socket
import string
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = []
TOKEN = "github_pat_TESTSECRET_do_not_log_" + "".join(random.choices(string.ascii_letters, k=12))


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


def make_png(w=4, h=4):
    """Tiny valid PNG (so the server's magic-byte sniff accepts it)."""
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x80\x40\xc0" * w for _ in range(h))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


# --------------------------------------------------------------------------- mock api.github.com
class MockGitHub:
    """POST /repos/{owner}/{repo}/issues. Behaviour from the repo name, or from `mode` for mock/ok:
    ok -> 201 {html_url}; labelfail -> 422 while `labels` present, else 201; fail -> 500; auth -> 401; nourl -> 201 {}."""

    def __init__(self):
        self.requests = []
        self.mode = "ok"
        self.counter = 0
        self.lock = threading.Lock()
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def _send(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                try:
                    body = json.loads(raw or b"{}")
                except ValueError:
                    body = {"_raw": raw.decode(errors="replace")}
                parts = self.path.strip("/").split("/")
                if self.path == "/__mock/mode":
                    mock.mode = body.get("mode", "ok")
                    return self._send(200, {"mode": mock.mode})
                if len(parts) != 4 or parts[0] != "repos" or parts[3] != "issues":
                    return self._send(404, {"message": "Not Found"})
                owner, repo = parts[1], parts[2]
                with mock.lock:
                    mock.counter += 1
                    num = mock.counter
                    mock.requests.append({
                        "path": self.path, "owner": owner, "repo": repo, "body": body,
                        "headers": {k.lower(): v for k, v in self.headers.items()},
                    })
                behaviour = repo if owner == "mock" and repo != "ok" else mock.mode
                if behaviour == "auth":
                    return self._send(401, {"message": "Bad credentials"})
                if behaviour == "fail":
                    return self._send(500, {"message": "Internal boom"})
                if behaviour == "labelfail" and body.get("labels"):
                    return self._send(422, {"message": "Validation Failed", "errors": [{"resource": "Issue", "field": "labels", "code": "invalid"}]})
                if behaviour == "nourl":
                    return self._send(201, {"number": num})
                return self._send(201, {"number": num, "html_url": f"https://github.com/{owner}/{repo}/issues/{num}", "labels": [{"name": l} for l in body.get("labels", [])]})

        self.port = free_port()
        self.server = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self):
        self.thread.start()
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def set_mode(self, mode):
        import requests
        requests.post(f"http://127.0.0.1:{self.port}/__mock/mode", json={"mode": mode}, timeout=5)

    def since(self, idx):
        return self.requests[idx:]


# --------------------------------------------------------------------------- part 1: harness
def run_harness(gh, base):
    print("Part 1: tests/feedback_harness.ts")
    env = {**os.environ, "MOCK_GITHUB_ISSUES_URL": base, "GITHUB_ISSUES_TOKEN": TOKEN, "GITHUB_ISSUES_REPO": "mock/ok",
           "APP_URL": "https://mmv.example.test"}
    env.pop("MOCK_GITHUB_ISSUE_JSON", None)
    try:
        proc = subprocess.run(["npx", "tsx", "tests/feedback_harness.ts"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        check("harness finished", False, "timeout")
        return
    if proc.returncode != 0:
        check("harness exit 0", False, (proc.stderr or proc.stdout)[-800:])
        return
    check("token never appears in harness stdout/stderr (logs)", TOKEN not in proc.stdout and TOKEN not in proc.stderr)
    line = [l for l in proc.stdout.splitlines() if l.startswith("{")][-1]
    r = json.loads(line)

    t = r["titles"]
    check("title: '[Report] ' + first 60 chars + ellipsis", t["long"] == "[Report] " + "x" * 60 + "…", t["long"])
    check("title: whitespace/newlines collapsed, no ellipsis when short", t["short"] == "[Report] Button broken on load", t["short"])
    check("title: exactly 60 chars -> no ellipsis", t["exact60"] == "[Report] " + "a" * 60, t["exact60"])
    check("title: kind=problem explicit -> [Report]", t["explicitProblem"] == "[Report] Button broken", t["explicitProblem"])
    check("title: kind=suggestion -> '[Idea] ' + collapsed message", t["idea"] == "[Idea] Sort closet by colour", t["idea"])
    check("title: kind=suggestion long -> [Idea] + 60 chars + ellipsis", t["ideaLong"] == "[Idea] " + "y" * 60 + "…", t["ideaLong"])
    check("title: unknown kind falls back to [Report]", t["unknownKind"] == "[Report] Button broken", t["unknownKind"])
    lb = r["labels"]
    check("labels: problem -> ['user-report'], suggestion -> ['suggestion'], default/unknown -> ['user-report']",
          lb["problem"] == ["user-report"] and lb["suggestion"] == ["suggestion"] and lb["defaulted"] == ["user-report"] and lb["unknown"] == ["user-report"]
          and lb["byKind"] == {"problem": ["user-report"], "suggestion": ["suggestion"]}, lb)

    b = r["body"]
    check("body: problem heading '## What happened'", b.startswith("## What happened\n\n"), b[:40])
    check("body: message present", "The upload button does nothing on iOS Safari" in b and "Tried twice." in b)
    check("body: reporter 'name @handle (user id N)'", "**Reporter:** Jane Doe @janed (user id 7)" in b, b)
    check("body: page", "**Page:** /crews/3/day/2026-10-01" in b)
    check("body: device / user agent", "**Device / user agent:** Mozilla/5.0 (iPhone" in b)
    check("body: app version", "**App version:** 1.4.2" in b)
    check("body: timestamp ISO", "**Timestamp:** 2026-10-01T21:36:00.000Z" in b)
    check("body: last error inside a code block, inner fences neutralised",
          "## Last error\n\n```\nTypeError: Cannot read properties" in b and "` ` `not a fence` ` `\n```" in b, b)
    check("body: public (Supabase) screenshot linked as image + url",
          "![screenshot](https://proj.supabase.co/storage/v1/object/public/outfits/feedback/42.png)" in b)
    b2 = r["bodyNoReporter"]
    check("body: unknown reporter -> 'user id N'; missing fields -> placeholders",
          "**Reporter:** user id 7" in b2 and "**Page:** _not provided_" in b2 and "_none captured_" in b2 and "## Screenshot\n\n_none_" in b2, b2)
    check("body: local screenshot without APP_URL -> marked not public, path shown",
          "_attached, not publicly reachable_ (`/uploads/feedback/42.png`)" in r["bodyLocalShotNoAppUrl"] and "![screenshot]" not in r["bodyLocalShotNoAppUrl"], r["bodyLocalShotNoAppUrl"])
    check("body: local screenshot with APP_URL -> absolute link",
          "![screenshot](https://mmv.onrender.com/uploads/feedback/42.png)" in r["bodyLocalShotAppUrl"], r["bodyLocalShotAppUrl"])
    ib = r["ideaBody"]
    check("idea body: '## The idea' heading, no 'What happened'", ib.startswith("## The idea\n\n") and "What happened" not in ib, ib[:60])
    check("idea body: message, reporter, context kept", "Let me reorder my closet by colour." in ib and "**Reporter:** Jane Doe @janed (user id 7)" in ib and "**Feedback id:** 43" in ib, ib)
    check("idea body: no 'Last error' section when lastError empty", "## Last error" not in ib and "_none captured_" not in ib, ib)
    check("idea body: screenshot section + 'Suggest an idea' footer", "## Screenshot\n\n_none_" in ib and "Suggest an idea" in ib, ib)
    ibe = r["ideaBodyWithError"]
    check("idea body: 'Last error' included when lastError non-empty", "## Last error\n\n```\nError: boom\n```" in ibe, ibe)
    pu = r["publicUrl"]
    check("publicScreenshotUrl: absolute kept, local needs APP_URL, null passthrough",
          pu["absolute"].startswith("https://x.supabase.co/") and pu["localNoBase"] is None and pu["localBase"] == "https://mmv.onrender.com/uploads/feedback/1.png" and pu["none"] is None, pu)

    c = r["config"]
    check("config: nothing set -> null (filing disabled)", c["none"] is None, c["none"])
    check("config: default repo bridgewaterchevy/mmv", c["defaultRepo"] == "bridgewaterchevy/mmv" == c["constDefault"], c)
    check("config: github.com URL normalised to owner/repo", c["urlRepo"] == "foo/bar", c["urlRepo"])
    check("config: malformed repo -> null", c["badRepo"] is None, c["badRepo"])
    check("config: labels == ['user-report']", c["labels"] == ["user-report"], c["labels"])

    ok = r["ok"]
    check("file: ok -> url from html_url, 1 attempt, labels kept", ok["url"] == "https://github.com/mock/ok/issues/1" and ok["attempts"] == 1 and ok["withoutLabels"] is False, ok)
    first = gh.requests[0]
    check("file: POST /repos/mock/ok/issues", first["path"] == "/repos/mock/ok/issues", first["path"])
    check("file: Authorization: Bearer <token>", first["headers"].get("authorization") == f"Bearer {TOKEN}", first["headers"].get("authorization", "")[:20])
    check("file: Accept application/vnd.github+json + X-GitHub-Api-Version + User-Agent",
          first["headers"].get("accept") == "application/vnd.github+json" and first["headers"].get("x-github-api-version") == "2022-11-28" and "mmv" in first["headers"].get("user-agent", ""), first["headers"])
    check("file: payload title/body/labels", first["body"]["title"].startswith("[Report] The upload button") and first["body"]["body"] == b and first["body"]["labels"] == ["user-report"], list(first["body"].keys()))
    oi = r["okIdea"]
    second = gh.requests[1]
    check("file: suggestion ok -> url, 1 attempt, labels kept", oi["url"] == "https://github.com/mock/ok/issues/2" and oi["attempts"] == 1 and oi["withoutLabels"] is False, oi)
    check("file: suggestion payload '[Idea]' title, 'suggestion' label, idea body",
          second["body"]["title"] == "[Idea] Let me reorder my closet by colour. Would make mornings fast…" and second["body"]["labels"] == ["suggestion"] and second["body"]["body"] == ib, second["body"].get("title"))

    lr = r["labelRetry"]
    reqs = [q for q in gh.requests if q["repo"] == "labelfail"]
    check("label retry: 2 attempts, second without labels, url returned", lr["url"] == "https://github.com/mock/labelfail/issues/4" and lr["attempts"] == 2 and lr["withoutLabels"] is True, lr)
    check("label retry: first request had labels, second had none, same title/body",
          len(reqs) == 2 and reqs[0]["body"].get("labels") == ["user-report"] and "labels" not in reqs[1]["body"] and reqs[0]["body"]["title"] == reqs[1]["body"]["title"] and reqs[0]["body"]["body"] == reqs[1]["body"]["body"],
          [list(q["body"].keys()) for q in reqs])

    f = r["fail"]
    check("failure: 500 -> url null, error mentions HTTP 500, no throw", f["url"] is None and "HTTP 500" in (f["error"] or ""), f)
    a = r["auth"]
    check("failure: 401 -> single attempt (no pointless retry), url null", a["url"] is None and a["attempts"] == 1 and "401" in (a["error"] or ""), a)
    check("failure: 201 without html_url -> url null", r["noHtmlUrl"]["url"] is None and "html_url" in (r["noHtmlUrl"]["error"] or ""), r["noHtmlUrl"])
    check("not configured -> 0 attempts, url null", r["notConfigured"] == {"url": None, "attempts": 0, "withoutLabels": False, "error": "not configured"}, r["notConfigured"])
    check("unreachable host -> url null, no throw", r["network"]["url"] is None and r["network"]["error"], r["network"])
    check("canned MOCK_GITHUB_ISSUE_JSON success -> url", r["cannedOk"]["url"] == "https://github.com/canned/repo/issues/9", r["cannedOk"])
    check("canned MOCK_GITHUB_ISSUE_JSON {status:503} -> url null", r["cannedFail"]["url"] is None and "503" in (r["cannedFail"]["error"] or ""), r["cannedFail"])

    ad = r["admins"]
    check("ADMIN_HANDLES: trimmed, lowercased, '@' stripped, empties dropped", ad["parsed"] == ["jane", "bob", "bridgewaterchevy"], ad["parsed"])
    check("isAdmin: case-insensitive match, no prefix match, empty/unset -> false", ad["yes"] is True and ad["no"] is False and ad["empty"] is False and ad["unset"] is False, ad)


# --------------------------------------------------------------------------- part 2: server
def run_server_test(gh, gh_base):
    print("Part 2: /api/feedback against a mocked server")
    import requests
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    tmp = tempfile.mkdtemp(prefix="mmv-feedback-srv-")
    env = {**os.environ, "PORT": str(port), "NODE_ENV": "development", "PGLITE_DIR": os.path.join(tmp, "pglite"),
           "MOCK_GITHUB_ISSUES_URL": gh_base, "GITHUB_ISSUES_TOKEN": TOKEN, "GITHUB_ISSUES_REPO": "mock/ok",
           "ADMIN_HANDLES": " Fb_Admin , someoneelse", "APP_URL": base}
    for k in ("DATABASE_URL", "SUPABASE_DB_PASSWORD", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY", "MOCK_GITHUB_ISSUE_JSON"):
        env.pop(k, None)
    log_path = os.path.join(tmp, "server.log")
    log = open(log_path, "w")
    proc = subprocess.Popen(["npx", "tsx", "server/index.ts"], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
    created_ids = []
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
            check("server booted", False, open(log_path).read()[-800:])
            return

        def api(method, path, token=None, **kw):
            headers = kw.pop("headers", {})
            if token:
                headers["x-auth-token"] = token
            return requests.request(method, base + path, headers=headers, timeout=30, **kw)

        rnd = lambda p: p + "".join(random.choices(string.ascii_lowercase, k=6))  # noqa: E731
        adm = api("POST", "/api/auth/signup", json={"name": "Admin", "handle": "fb_admin", "pin": "1234"})
        if adm.status_code == 409:  # pglite dir is fresh, but be safe
            adm = api("POST", "/api/auth/login", json={"handle": "fb_admin", "pin": "1234"})
        tok_adm = adm.json()["token"]
        usr = api("POST", "/api/auth/signup", json={"name": "Reporter Rae", "handle": rnd("fb_user_"), "pin": "1234"})
        tok_u, user = usr.json()["token"], usr.json()["user"]
        other = api("POST", "/api/auth/signup", json={"name": "Other", "handle": rnd("fb_other_"), "pin": "1234"}).json()["token"]

        me = api("GET", "/api/me", tok_adm).json()
        check("GET /api/me: isAdmin true for ADMIN_HANDLES entry (case-insensitive, trimmed)", me.get("isAdmin") is True, me)
        check("GET /api/me: isAdmin false for others", api("GET", "/api/me", tok_u).json().get("isAdmin") is False)

        # ---- JSON report
        n0 = len(gh.requests)
        r = api("POST", "/api/feedback", tok_u, json={"message": "Crew page is blank after login", "page": "/crews/9", "userAgent": "UA-test/1", "appVersion": "2.0.0", "lastError": "ReferenceError: x is not defined"})
        body = r.json()
        ok = check("POST /api/feedback JSON -> 200 {id, kind, githubIssueUrl}", r.status_code == 200 and isinstance(body.get("id"), int) and body.get("githubIssueUrl", "").startswith("https://github.com/mock/ok/issues/") and "kind" in body, f"{r.status_code} {r.text[:200]}")
        if not ok:
            return
        check("POST without kind -> kind defaults to 'problem'", body.get("kind") == "problem", body.get("kind"))
        created_ids.append(body["id"])
        sent = gh.since(n0)
        check("issue filed once with labels", len(sent) == 1 and sent[0]["body"].get("labels") == ["user-report"], [q["body"].get("labels") for q in sent])
        ib = sent[0]["body"]["body"]
        check("issue title from message", sent[0]["body"]["title"] == "[Report] Crew page is blank after login", sent[0]["body"]["title"])
        check("issue body: '## What happened' heading for problems", ib.startswith("## What happened\n\n"), ib[:40])
        check("issue body: message, reporter name/@handle/id, page, UA, version, error code block, feedback id",
              "Crew page is blank after login" in ib and f"**Reporter:** Reporter Rae @{user['handle']} (user id {user['id']})" in ib and "**Page:** /crews/9" in ib
              and "**Device / user agent:** UA-test/1" in ib and "**App version:** 2.0.0" in ib and "```\nReferenceError: x is not defined\n```" in ib and f"**Feedback id:** {body['id']}" in ib and "## Screenshot\n\n_none_" in ib, ib)
        check("issue request carries Bearer token", sent[0]["headers"].get("authorization") == f"Bearer {TOKEN}")

        # ---- multipart with a PNG screenshot
        n1 = len(gh.requests)
        png = make_png()
        r = api("POST", "/api/feedback", tok_u, files={"screenshot": ("shot.png", png, "image/png")}, data={"message": "See screenshot", "page": "/closet", "appVersion": "", "lastError": "", "kind": ""})
        body = r.json()
        ok = check("POST /api/feedback multipart + PNG -> 200", r.status_code == 200 and isinstance(body.get("id"), int) and body.get("githubIssueUrl"), f"{r.status_code} {r.text[:200]}")
        if ok:
            check("multipart kind='' -> defaults to 'problem'", body.get("kind") == "problem", body.get("kind"))
            created_ids.append(body["id"])
            fid = body["id"]
            sent = gh.since(n1)
            ib = sent[0]["body"]["body"]
            shot_url = f"{base}/uploads/feedback/{fid}.png"
            check("screenshot stored at /uploads/feedback/<id>.png and served back as PNG", requests.get(shot_url, timeout=10).content == png, shot_url)
            check("issue body links the screenshot via APP_URL", f"![screenshot]({shot_url})" in ib, ib)
            check("empty multipart fields -> placeholders (not '')", "**App version:** _not provided_" in ib and "_none captured_" in ib, ib)
            check("user agent falls back to the request header when not sent", "**Device / user agent:** python-requests" in ib, ib)

        # ---- validation
        check("POST without message -> 400", api("POST", "/api/feedback", tok_u, json={"page": "/x"}).status_code == 400)
        check("POST empty message -> 400", api("POST", "/api/feedback", tok_u, json={"message": "   "}).status_code == 400)
        check("POST message > 2000 chars -> 400", api("POST", "/api/feedback", tok_u, json={"message": "m" * 2001}).status_code == 400)
        check("POST lastError > 4000 chars -> 400", api("POST", "/api/feedback", tok_u, json={"message": "ok", "lastError": "e" * 4001}).status_code == 400)
        check("POST no token -> 401", api("POST", "/api/feedback", json={"message": "hi"}).status_code == 401)
        bad = api("POST", "/api/feedback", tok_u, json={"message": "ok", "kind": "complaint"})
        check("POST invalid kind -> 400 mentioning problem/suggestion", bad.status_code == 400 and "suggestion" in bad.text, f"{bad.status_code} {bad.text[:120]}")
        bad = api("POST", "/api/feedback", tok_u, json={"message": "ok", "kind": "Problem"})
        check("POST kind is case-sensitive ('Problem' -> 400)", bad.status_code == 400, f"{bad.status_code} {bad.text[:120]}")
        bad = api("POST", "/api/feedback", tok_u, files={"screenshot": ("x.png", b"definitely not a png " * 4, "image/png")}, data={"message": "fake png"})
        check("POST text bytes declared image/png -> 400 (magic-byte sniff)", bad.status_code == 400, f"{bad.status_code} {bad.text[:120]}")
        bad = api("POST", "/api/feedback", tok_u, files={"screenshot": ("x.txt", b"hello", "text/plain")}, data={"message": "txt"})
        check("POST text/plain screenshot -> 400", bad.status_code == 400, f"{bad.status_code} {bad.text[:120]}")
        big = api("POST", "/api/feedback", tok_u, files={"screenshot": ("big.png", png + b"\x00" * (5 * 1024 * 1024), "image/png")}, data={"message": "too big"})
        check("POST screenshot > 5 MB -> 400", big.status_code == 400 and "5 MB" in big.text, f"{big.status_code} {big.text[:120]}")
        n_before = len(gh.requests)
        check("validation failures never hit GitHub", len(gh.requests) == n_before)

        # ---- GitHub failure is non-blocking
        gh.set_mode("fail")
        n2 = len(gh.requests)
        r = api("POST", "/api/feedback", tok_u, json={"message": "GitHub is down but I still want to report"})
        body = r.json()
        check("GitHub 500 -> report saved, 200 {id, githubIssueUrl: null}", r.status_code == 200 and isinstance(body.get("id"), int) and body.get("githubIssueUrl") is None and "githubIssueUrl" in body, f"{r.status_code} {r.text[:200]}")
        if isinstance(body.get("id"), int):
            created_ids.append(body["id"])
        check("GitHub 500 -> one retry without labels, then gave up (2 requests)", len(gh.since(n2)) == 2 and "labels" not in gh.since(n2)[1]["body"], [list(q["body"].keys()) for q in gh.since(n2)])
        failed_id = body.get("id")

        # ---- label retry end to end (as a suggestion: first attempt carries the "suggestion" label)
        gh.set_mode("labelfail")
        n3 = len(gh.requests)
        r = api("POST", "/api/feedback", tok_u, json={"message": "label retry please", "kind": "suggestion"})
        body = r.json()
        check("label 422 -> retried without labels, url stored", r.status_code == 200 and (body.get("githubIssueUrl") or "").startswith("https://github.com/mock/ok/issues/") and len(gh.since(n3)) == 2 and "labels" not in gh.since(n3)[1]["body"], f"{r.text[:200]} {[list(q['body'].keys()) for q in gh.since(n3)]}")
        check("label retry: suggestion sent ['suggestion'] first, '[Idea]' title both times",
              len(gh.since(n3)) == 2 and gh.since(n3)[0]["body"].get("labels") == ["suggestion"] and all(q["body"]["title"] == "[Idea] label retry please" for q in gh.since(n3)), [(q["body"].get("labels"), q["body"]["title"]) for q in gh.since(n3)])
        if isinstance(body.get("id"), int):
            created_ids.append(body["id"])
        gh.set_mode("ok")

        # ---- suggestion end to end (5th report for this user; the limit is shared across kinds)
        n4 = len(gh.requests)
        r5 = api("POST", "/api/feedback", tok_u, json={"message": "Add a dark mode for the closet", "kind": "suggestion", "page": "/closet", "appVersion": "2.0.0"})
        body = r5.json()
        ok = check("POST kind=suggestion -> 200 {id, kind:'suggestion', githubIssueUrl}", r5.status_code == 200 and body.get("kind") == "suggestion" and (body.get("githubIssueUrl") or "").startswith("https://github.com/mock/ok/issues/"), f"{r5.status_code} {r5.text[:200]}")
        suggestion_id = body.get("id") if ok else None
        if ok:
            created_ids.append(body["id"])
            sent = gh.since(n4)
            sb = sent[0]["body"]
            check("suggestion issue: '[Idea]' title + 'suggestion' label", sb["title"] == "[Idea] Add a dark mode for the closet" and sb.get("labels") == ["suggestion"], (sb["title"], sb.get("labels")))
            check("suggestion issue body: '## The idea', context, no 'Last error', 'Suggest an idea' footer",
                  sb["body"].startswith("## The idea\n\n") and "**Page:** /closet" in sb["body"] and "## Last error" not in sb["body"] and "Suggest an idea" in sb["body"], sb["body"])

        # ---- per-user rate limit is shared across kinds: 5 saved so far (4 problems + 1 suggestion); 6th 429 either kind
        r6 = api("POST", "/api/feedback", tok_u, json={"message": "sixth report"})
        r6s = api("POST", "/api/feedback", tok_u, json={"message": "sixth as idea", "kind": "suggestion"})
        check("rate limit: 5th report 200, 6th in the same hour -> 429 (problem and suggestion alike)", r5.status_code == 200 and r6.status_code == 429 and r6s.status_code == 429, f"{r5.status_code} {r6.status_code} {r6s.status_code} {r6.text[:120]}")
        r_other = api("POST", "/api/feedback", other, json={"message": "other user's first report"})
        check("rate limit is per user: another user still 200", r_other.status_code == 200, f"{r_other.status_code} {r_other.text[:120]}")
        if r_other.status_code == 200:
            created_ids.append(r_other.json()["id"])

        # ---- admin gating
        check("GET /api/feedback no token -> 401", api("GET", "/api/feedback").status_code == 401)
        check("GET /api/feedback non-admin -> 403", api("GET", "/api/feedback", tok_u).status_code == 403)
        lst = api("GET", "/api/feedback", tok_adm)
        items = lst.json() if lst.status_code == 200 else None
        check("GET /api/feedback admin -> 200 list", lst.status_code == 200 and isinstance(items, list) and len(items) >= 6, f"{lst.status_code} {lst.text[:160]}")
        if items:
            check("list: newest first", [i["id"] for i in items] == sorted((i["id"] for i in items), reverse=True), [i["id"] for i in items])
            first = items[0]
            check("list: rows carry user {id,name,handle}, kind, status, githubIssueUrl, screenshotPath, createdAt, message, page",
                  all(k in first for k in ("id", "kind", "message", "page", "userAgent", "appVersion", "lastError", "screenshotPath", "githubIssueUrl", "status", "createdAt", "user"))
                  and isinstance(first["user"], dict) and all(k in first["user"] for k in ("id", "name", "handle")), list(first.keys()))
            by_id = {i["id"]: i for i in items}
            check("list: reporter resolved by name/handle", by_id[created_ids[0]]["user"]["handle"] == user["handle"] and by_id[created_ids[0]]["user"]["name"] == "Reporter Rae", by_id[created_ids[0]]["user"])
            check("list: all open by default", all(i["status"] == "open" for i in items))
            check("list: failed GitHub filing kept with githubIssueUrl null", failed_id in by_id and by_id[failed_id]["githubIssueUrl"] is None, by_id.get(failed_id))
            check("list: screenshot report carries screenshotPath", len(created_ids) > 1 and by_id[created_ids[1]]["screenshotPath"] == f"/uploads/feedback/{created_ids[1]}.png", by_id.get(created_ids[1], {}).get("screenshotPath"))
            check("list: no pin/token leakage", all("pin" not in i["user"] and "token" not in i["user"] for i in items if i["user"]))
            check("list: kind is 'problem' for reports sent without kind, 'suggestion' for the idea",
                  by_id[created_ids[0]]["kind"] == "problem" and suggestion_id in by_id and by_id[suggestion_id]["kind"] == "suggestion", {i["id"]: i["kind"] for i in items})
            n_sugg = sum(1 for i in items if i["kind"] == "suggestion")
            fs = api("GET", "/api/feedback?kind=suggestion", tok_adm)
            fs_items = fs.json() if fs.status_code == 200 else None
            check("GET /api/feedback?kind=suggestion -> only suggestions (2: label-retry idea + dark mode)",
                  fs.status_code == 200 and isinstance(fs_items, list) and len(fs_items) == n_sugg == 2 and all(i["kind"] == "suggestion" for i in fs_items), f"{fs.status_code} {[(i['id'], i['kind']) for i in (fs_items or [])]}")
            fp = api("GET", "/api/feedback?kind=problem", tok_adm)
            fp_items = fp.json() if fp.status_code == 200 else None
            check("GET /api/feedback?kind=problem -> only problems, together they cover the full list",
                  fp.status_code == 200 and isinstance(fp_items, list) and all(i["kind"] == "problem" for i in fp_items) and len(fp_items) + len(fs_items or []) == len(items), f"{fp.status_code} {len(fp_items or [])}+{len(fs_items or [])} vs {len(items)}")
            check("GET /api/feedback?kind= (empty) -> unfiltered", len(api("GET", "/api/feedback?kind=", tok_adm).json()) == len(items))
            fb_bad = api("GET", "/api/feedback?kind=bogus", tok_adm)
            check("GET /api/feedback?kind=bogus -> 400", fb_bad.status_code == 400, f"{fb_bad.status_code} {fb_bad.text[:120]}")
            check("GET /api/feedback?kind=suggestion non-admin -> 403", api("GET", "/api/feedback?kind=suggestion", tok_u).status_code == 403)

        # ---- PATCH status
        fid = created_ids[0]
        check("PATCH /api/feedback/:id non-admin -> 403", api("PATCH", f"/api/feedback/{fid}", tok_u, json={"status": "resolved"}).status_code == 403)
        check("PATCH no token -> 401", api("PATCH", f"/api/feedback/{fid}", json={"status": "resolved"}).status_code == 401)
        check("PATCH invalid status -> 400", api("PATCH", f"/api/feedback/{fid}", tok_adm, json={"status": "done"}).status_code == 400)
        check("PATCH unknown id -> 404", api("PATCH", "/api/feedback/999999", tok_adm, json={"status": "resolved"}).status_code == 404)
        p = api("PATCH", f"/api/feedback/{fid}", tok_adm, json={"status": "resolved"})
        check("PATCH admin {status:'resolved'} -> 200 report with status resolved + user", p.status_code == 200 and p.json().get("status") == "resolved" and p.json().get("user", {}).get("handle") == user["handle"], f"{p.status_code} {p.text[:200]}")
        lst = api("GET", "/api/feedback", tok_adm).json()
        check("GET reflects resolved status", any(i["id"] == fid and i["status"] == "resolved" for i in lst))
        p = api("PATCH", f"/api/feedback/{fid}", tok_adm, json={"status": "open"})
        check("PATCH back to open -> 200", p.status_code == 200 and p.json().get("status") == "open")

        log.flush()
        check("token never written to server log", TOKEN not in open(log_path).read())
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        for fid in created_ids:  # local store: screenshots land in ./uploads/feedback
            for ext in (".png", ".jpg", ".webp", ".gif", ".heic"):
                try:
                    os.remove(os.path.join(ROOT, "uploads", "feedback", f"{fid}{ext}"))
                except OSError:
                    pass
        if any(not ok for _, ok, _ in RESULTS):
            print("---- server.log tail ----")
            print(open(log_path).read()[-1500:])
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    try:
        import requests  # noqa: F401
    except ImportError:
        print("pip install requests", file=sys.stderr)
        sys.exit(2)
    gh = MockGitHub()
    gh_base = gh.start()
    try:
        run_harness(gh, gh_base)
        gh.requests.clear()
        gh.mode = "ok"
        run_server_test(gh, gh_base)
    finally:
        gh.stop()
    npass = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{npass}/{len(RESULTS)} checks passed")
    for name, ok, detail in RESULTS:
        if not ok:
            print(f"FAIL {name} -> {detail}")
    sys.exit(0 if npass == len(RESULTS) else 1)


if __name__ == "__main__":
    main()
