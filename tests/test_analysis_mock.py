#!/usr/bin/env python3
"""
Offline test for the asynchronous outfit analysis (server/analysis.ts + the picks routes).
No Gemini key, no network: a tiny fake Gemini runs on localhost and the server is pointed at it through
the CUSTOM_CRED_GENERATIVELANGUAGE_GOOGLEAPIS_COM_URL / _PROXY_AUTH_KEY hooks that server/vision.ts
already honours. The fake adds latency, counts concurrent requests and can be told to fail.

    python tests/test_analysis_mock.py          # from the repo root; needs node_modules + `requests`

Checks (one throwaway pglite dir, local ./uploads):
  POST /api/sessions/:id/picks answers 201 in < 2 s with analysisStatus "pending", items [] and
    Cache-Control: no-store while the fake Gemini is still sleeping; GET /api/picks/:id then settles to
    "ready" with the mocked items, analyzedAt set, analysisError null, note = vision summary when blank.
  Burst of 5 uploads -> the fake Gemini never sees more than VISION_CONCURRENCY (2) requests at once; all 5 ready.
  Stale guard: re-posting a new photo while the first analysis is in flight -> the final pick carries the
    second photo and the summary of the LAST Gemini call; the stale result never overwrites it.
  Failure: fake Gemini 500 -> analysisStatus "failed", short analysisError ("Gemini 500: ..."), analysisFailed true,
    previous items kept? (no: fresh upload -> []); POST /api/picks/:id/analyze by owner -> pending -> ready again;
    non-owner 403; non-member GET 403; while pending a second analyze -> 202.
  Retry rate limit: 10 successful analyze calls per hour per user, the 11th -> 429.
  Boot recovery: kill the server while a job is in flight, restart with VISION_RECOVERY_AGE_MS=0 -> the
    pending pick is re-queued ("[analysis] recovery: re-queued 1") and settles to ready.
Exit code 0 only if everything passes.
"""
import io
import json
import os
import random
import shutil
import signal
import socket
import string
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = []


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


# --------------------------------------------------------------------------- fake Gemini
GEM = {"delay": 2.0, "fail_next": 0, "calls": 0, "inflight": 0, "max_inflight": 0, "lock": threading.Lock(), "keys": []}


def gemini_body(n):
    analysis = {
        "summary": f"mock outfit {n}",
        "palette": ["#111111", "#3a5ca0"],
        "items": [
            {"category": "leggings", "description": "black leggings", "colorName": "black", "colorHex": "#111111",
             "brandGuess": None, "searchQuery": f"black leggings {n}", "fit": "womens"},
            {"category": "shoes", "description": "white running shoes", "colorName": "white", "colorHex": "#f0f0f0",
             "brandGuess": None, "searchQuery": "white running shoes", "fit": "unisex"},
        ],
    }
    return {"candidates": [{"content": {"parts": [{"text": json.dumps(analysis)}]}}]}


class FakeGemini(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(n)
        with GEM["lock"]:
            GEM["calls"] += 1
            call = GEM["calls"]
            GEM["inflight"] += 1
            GEM["max_inflight"] = max(GEM["max_inflight"], GEM["inflight"])
            GEM["keys"].append(self.headers.get("x-api-key"))
            fail = GEM["fail_next"] > 0
            if fail:
                GEM["fail_next"] -= 1
            delay = GEM["delay"]
        try:
            time.sleep(delay)
            if fail:
                body = json.dumps({"error": {"code": 500, "message": "simulated outage secret=abc123 token=zzz"}}).encode()
                self.send_response(500)
            else:
                body = json.dumps(gemini_body(call)).encode()
                self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the server was killed mid-request (recovery scenario)
        finally:
            with GEM["lock"]:
                GEM["inflight"] -= 1


def make_jpeg(seed):
    """Tiny valid-enough JPEG header + unique payload so photos differ."""
    return b"\xff\xd8\xff\xe0" + bytes([seed % 256]) * 64 + os.urandom(16)


# --------------------------------------------------------------------------- server control
def boot(port, env, tmp, log_name):
    log = open(os.path.join(tmp, log_name), "a")
    # Own process group so kill_group() takes the tsx child down too (npx -> tsx -> node); otherwise the old
    # server keeps the port and the "restart" would silently talk to it.
    proc = subprocess.Popen(["npx", "tsx", "server/index.ts"], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    import requests
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        try:
            if requests.get(base + "/api/health", timeout=2).status_code == 200:
                return proc, log
        except requests.RequestException:
            pass
        if proc.poll() is not None:
            break
        time.sleep(0.5)
    log.flush()
    raise RuntimeError("server did not boot: " + open(os.path.join(tmp, log_name)).read()[-1200:])


def kill_group(proc, sig=signal.SIGKILL):
    """Kill the whole npx/tsx/node group and wait until the port is actually released."""
    try:
        os.killpg(os.getpgid(proc.pid), sig)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        proc.wait()


def wait_port_free(port, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        s = socket.socket()
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # ignore TIME_WAIT leftovers from our own requests
        try:
            s.bind(("0.0.0.0", port))
            s.close()
            return True
        except OSError:
            s.close()
            time.sleep(0.2)
    return False


def stop(proc):
    if proc.poll() is None:
        kill_group(proc, signal.SIGTERM)


def main():
    try:
        import requests
    except ImportError:
        check("requests installed", False, "pip install requests")
        return
    gport = free_port()
    gsrv = ThreadingHTTPServer(("127.0.0.1", gport), FakeGemini)
    threading.Thread(target=gsrv.serve_forever, daemon=True).start()

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    tmp = tempfile.mkdtemp(prefix="mmv-analysis-")
    env = {**os.environ, "PORT": str(port), "NODE_ENV": "development", "PGLITE_DIR": os.path.join(tmp, "pglite"),
           "CUSTOM_CRED_GENERATIVELANGUAGE_GOOGLEAPIS_COM_URL": f"http://127.0.0.1:{gport}",
           "CUSTOM_CRED_GENERATIVELANGUAGE_GOOGLEAPIS_COM_PROXY_AUTH_KEY": "fake-proxy-key",
           "GEMINI_MODEL": "mock-model", "VISION_CONCURRENCY": "2", "VISION_SWEEP": "0"}
    for k in ("DATABASE_URL", "SUPABASE_DB_PASSWORD", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY",
              "MOCK_VISION_JSON", "VISION_RECOVERY_AGE_MS", "VISION_TIMEOUT_MS"):
        env.pop(k, None)
    proc = log = None
    uploaded_paths = []
    try:
        proc, log = boot(port, env, tmp, "server.log")

        def api(method, path, token=None, **kw):
            headers = kw.pop("headers", {})
            if token:
                headers["x-auth-token"] = token
            return requests.request(method, base + path, headers=headers, timeout=30, **kw)

        def poll(pick_id, token, timeout=30, until=("ready", "failed")):
            deadline = time.time() + timeout
            last = None
            while time.time() < deadline:
                r = api("GET", f"/api/picks/{pick_id}", token)
                if r.status_code != 200:
                    return r.status_code, None
                last = r.json()
                if last.get("analysisStatus") in until:
                    return 200, last
                time.sleep(0.2)
            return 200, last

        rnd = lambda p: p + "".join(random.choices(string.ascii_lowercase, k=8))  # noqa: E731
        users = []
        for i in range(6):
            r = api("POST", "/api/auth/signup", json={"name": f"U{i}", "handle": rnd(f"an{i}_"), "pin": "1234"})
            users.append(r.json()["token"])
        owner, member, outsider = users[0], users[1], users[5]
        crew = api("POST", "/api/crews", owner, json={"name": "Async", "activity": "Gym"}).json()
        for t in users[1:5]:
            api("POST", "/api/crews/join", t, json={"inviteCode": crew["inviteCode"]})
        sess = api("GET", f"/api/crews/{crew['id']}/day/2031-01-01", owner).json()
        sid = sess["id"]

        # ---- 1. instant 201 + pending, then ready
        GEM["delay"] = 2.0
        t0 = time.time()
        up = api("POST", f"/api/sessions/{sid}/picks", owner, files={"photo": ("a.jpg", make_jpeg(1), "image/jpeg")})
        dt = time.time() - t0
        p = up.json()
        uploaded_paths.append(p.get("photoPath"))
        check("upload -> 201 in < 2 s while Gemini sleeps 2 s", up.status_code == 201 and dt < 2.0, f"{up.status_code} in {dt:.2f}s")
        check("upload: analysisStatus pending, items/palette [], analysisError null, analyzedAt null, analysisFailed false",
              p.get("analysisStatus") == "pending" and p.get("items") == [] and p.get("palette") == [] and p.get("analysisError") is None
              and p.get("analyzedAt") is None and p.get("analysisFailed") is False, str(p)[:300])
        check("upload: Cache-Control: no-store", "no-store" in up.headers.get("Cache-Control", "").lower(), up.headers.get("Cache-Control"))
        g = api("GET", f"/api/picks/{p['id']}", member)
        check("GET /api/picks/:id by crew member -> 200 pending + no-store",
              g.status_code == 200 and g.json().get("analysisStatus") == "pending" and "no-store" in g.headers.get("Cache-Control", "").lower(), f"{g.status_code} {g.headers.get('Cache-Control')}")
        check("GET /api/picks/:id by non-member -> 403", api("GET", f"/api/picks/{p['id']}", outsider).status_code == 403)
        check("GET /api/picks/:id no token -> 401", api("GET", f"/api/picks/{p['id']}").status_code == 401)
        check("GET /api/picks/:id unknown -> 404", api("GET", "/api/picks/999999", owner).status_code == 404)
        sv = api("GET", f"/api/sessions/{sid}", member)
        check("session view: picks carry analysisStatus pending + no-store",
              sv.status_code == 200 and sv.json()["picks"][0].get("analysisStatus") == "pending" and "no-store" in sv.headers.get("Cache-Control", "").lower(), sv.headers.get("Cache-Control"))
        code, done = poll(p["id"], member)
        check("polls settle to ready with 2 items, palette, analyzedAt, analysisError null",
              code == 200 and done and done.get("analysisStatus") == "ready" and len(done.get("items", [])) == 2 and done.get("palette") == ["#111111", "#3a5ca0"]
              and done.get("analyzedAt") and done.get("analysisError") is None and done.get("analysisFailed") is False, str(done)[:300])
        check("ready: note falls back to the vision summary", (done or {}).get("note", "").startswith("mock outfit"), repr((done or {}).get("note")))
        check("ready: items carry links/fit/shoppingQuery (pickView decoration)",
              bool(done) and all("links" in i and "fit" in i and "shoppingQuery" in i for i in done["items"]), str((done or {}).get("items"))[:200])
        check("fake Gemini received the proxy auth header", GEM["keys"] and GEM["keys"][-1] == "fake-proxy-key", GEM["keys"][-1:])

        # ---- 2. burst: 4 members upload at once -> concurrency capped at 2
        GEM["delay"] = 1.5
        with GEM["lock"]:
            GEM["max_inflight"] = 0
        results = {}

        def do_upload(idx, tok):
            r = api("POST", f"/api/sessions/{sid}/picks", tok, files={"photo": (f"b{idx}.jpg", make_jpeg(10 + idx), "image/jpeg")})
            results[idx] = (r.status_code, r.json())

        threads = [threading.Thread(target=do_upload, args=(i, users[i])) for i in range(1, 5)]
        t0 = time.time()
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        dt = time.time() - t0
        check("burst: 4 concurrent uploads all 201 pending within 3 s", len(results) == 4 and all(c == 201 and b.get("analysisStatus") == "pending" for c, b in results.values()) and dt < 3, f"{dt:.2f}s {[c for c, _ in results.values()]}")
        for _, b in results.values():
            uploaded_paths.append(b.get("photoPath"))
        finals = [poll(b["id"], owner, timeout=40)[1] for _, b in results.values()]
        check("burst: all 4 settle to ready with items", all(f and f.get("analysisStatus") == "ready" and len(f["items"]) == 2 for f in finals), [(f or {}).get("analysisStatus") for f in finals])
        check("burst: fake Gemini saw at most 2 requests in flight (VISION_CONCURRENCY=2)", 1 <= GEM["max_inflight"] <= 2, f"max_inflight={GEM['max_inflight']}")
        check("burst: took >= 2 rounds (4 jobs / 2 at a time x 1.5 s)", time.time() - t0 >= 2.9, f"{time.time() - t0:.2f}s")

        # ---- 3. stale guard: owner re-posts while the first analysis is in flight
        GEM["delay"] = 2.0
        first = api("POST", f"/api/sessions/{sid}/picks", owner, files={"photo": ("c1.jpg", make_jpeg(21), "image/jpeg")}).json()
        time.sleep(0.5)  # job for c1 is now inside the fake Gemini
        calls_before = GEM["calls"]
        second = api("POST", f"/api/sessions/{sid}/picks", owner, files={"photo": ("c2.jpg", make_jpeg(22), "image/jpeg")}, data={"note": "second photo"}).json()
        uploaded_paths += [first.get("photoPath"), second.get("photoPath")]
        check("re-post keeps the same pick id (upsert) and swaps the photo", first["id"] == second["id"] == p["id"] and first["photoPath"] != second["photoPath"])
        check("re-post answers pending with items [] again", second.get("analysisStatus") == "pending" and second.get("items") == [])
        code, final = poll(second["id"], owner, timeout=40)
        last_call = GEM["calls"]
        check("stale guard: final pick is ready for the SECOND photo", code == 200 and final and final["analysisStatus"] == "ready" and final["photoPath"] == second["photoPath"], str(final)[:200])
        check("stale guard: the second photo was analysed too (parked job ran after the first finished)", last_call >= calls_before + 1, f"calls {calls_before} -> {last_call}")
        check("stale guard: owner's note kept (no summary overwrite) and items come from the LAST Gemini call",
              final and final.get("note") == "second photo" and final["items"][0]["searchQuery"] == f"black leggings {last_call}", f"{(final or {}).get('note')!r} {((final or {}).get('items') or [{}])[0].get('searchQuery')!r} vs call {last_call}")
        time.sleep(2.5)  # make sure nothing lands late
        late = api("GET", f"/api/picks/{p['id']}", owner).json()
        check("stale guard: nothing overwrites the pick afterwards", late["items"][0]["searchQuery"] == final["items"][0]["searchQuery"] and late["analyzedAt"] == final["analyzedAt"])

        # ---- 4. failure -> failed + short error, then owner retry -> ready
        GEM["delay"] = 0.3
        with GEM["lock"]:
            GEM["fail_next"] = 1  # vision.ts retries only 429/503; a 500 moves to the next model, and GEMINI_MODEL lists one -> exactly 1 call
        bad = api("POST", f"/api/sessions/{sid}/picks", owner, files={"photo": ("d.jpg", make_jpeg(31), "image/jpeg")}).json()
        uploaded_paths.append(bad.get("photoPath"))
        code, failed = poll(bad["id"], owner)
        check("failure: analysisStatus failed, analysisFailed true, items []", failed and failed["analysisStatus"] == "failed" and failed["analysisFailed"] is True and failed["items"] == [], str(failed)[:200])
        err = (failed or {}).get("analysisError") or ""
        check("failure: analysisError is short and condensed ('Gemini 500: ...')", err.startswith("Gemini 500:") and len(err) <= 200, repr(err))
        check("failure: analysisError scrubbed (no secret=/token= values)", "abc123" not in err and "zzz" not in err, repr(err))
        check("failure: analyzedAt set", bool((failed or {}).get("analyzedAt")))
        with GEM["lock"]:
            GEM["fail_next"] = 0
        check("analyze: non-owner (member) -> 403", api("POST", f"/api/picks/{bad['id']}/analyze", member).status_code == 403)
        check("analyze: outsider -> 403", api("POST", f"/api/picks/{bad['id']}/analyze", outsider).status_code == 403)
        check("analyze: no token -> 401", api("POST", f"/api/picks/{bad['id']}/analyze").status_code == 401)
        check("analyze: unknown pick -> 404", api("POST", "/api/picks/999999/analyze", owner).status_code == 404)
        GEM["delay"] = 1.5
        ra = api("POST", f"/api/picks/{bad['id']}/analyze", owner)
        rb = ra.json()
        check("analyze: owner -> 200 PickView pending, analysisError cleared, no-store",
              ra.status_code == 200 and rb.get("analysisStatus") == "pending" and rb.get("analysisError") is None and "no-store" in ra.headers.get("Cache-Control", "").lower(), f"{ra.status_code} {str(rb)[:200]}")
        again = api("POST", f"/api/picks/{bad['id']}/analyze", owner)
        check("analyze: while already pending -> 202 (no second job)", again.status_code == 202 and again.json().get("analysisStatus") == "pending", f"{again.status_code}")
        calls_before = GEM["calls"]
        code, fixed = poll(bad["id"], owner)
        check("analyze: retry settles to ready with items", fixed and fixed["analysisStatus"] == "ready" and len(fixed["items"]) == 2 and fixed["analysisFailed"] is False, str(fixed)[:200])
        check("analyze: exactly one Gemini call for the retry (dedupe)", GEM["calls"] - calls_before <= 1, f"{GEM['calls'] - calls_before}")

        # ---- 5. retry rate limit: 10/h/user (1 used above) -> 9 more ok, 11th -> 429
        GEM["delay"] = 0.05
        codes = []
        for _ in range(10):
            r = api("POST", f"/api/picks/{bad['id']}/analyze", owner)
            codes.append(r.status_code)
            if r.status_code == 429:
                break
            poll(bad["id"], owner, timeout=15)
        check("analyze: rate limited after 10 retries/hour (11th -> 429)", codes[:9] == [200] * 9 and codes[9:10] == [429], f"codes={codes}")

        # ---- 6. boot recovery: kill mid-flight, restart with VISION_RECOVERY_AGE_MS=0
        GEM["delay"] = 8.0
        stuck = api("POST", f"/api/sessions/{sid}/picks", member, files={"photo": ("e.jpg", make_jpeg(41), "image/jpeg")}).json()
        uploaded_paths.append(stuck.get("photoPath"))
        time.sleep(0.8)  # job started, Gemini sleeping
        kill_group(proc)
        log.close()
        check("recovery: killed server released the port", wait_port_free(port), f"port {port} still bound")
        GEM["delay"] = 0.3
        gem_calls_before_restart = GEM["calls"]
        env2 = {**env, "VISION_RECOVERY_AGE_MS": "0"}
        proc, log = boot(port, env2, tmp, "server2.log")
        code, rec = poll(stuck["id"], member, timeout=30)
        check("recovery: pick left pending by the killed process settles to ready after restart",
              rec and rec["analysisStatus"] == "ready" and len(rec["items"]) == 2, str(rec)[:200])
        check("recovery: the NEW process made the Gemini call", GEM["calls"] == gem_calls_before_restart + 1, f"{gem_calls_before_restart} -> {GEM['calls']}")
        time.sleep(0.3)
        log.flush()
        text = open(os.path.join(tmp, "server2.log")).read()
        check("recovery: boot log reports the re-queued count", "[analysis] recovery: re-queued 1 pending pick(s)" in text, text[-600:])
        check("recovery: job loaded the photo from the file store (no upload buffer) and logged 'recovery'", "ready: 2 item(s)" in text and "(recovery)" in text, text[-600:])

        # ---- 7. with default recovery age (2 min) a fresh boot re-queues nothing
        kill_group(proc)
        log.close()
        wait_port_free(port)
        proc, log = boot(port, env, tmp, "server3.log")
        time.sleep(0.3)
        log.flush()
        text3 = open(os.path.join(tmp, "server3.log")).read()
        check("default boot: 're-queued 0' when nothing is stuck", "re-queued 0 pending pick(s) older than 120s" in text3, text3[-400:])

        # ---- cleanup picks (also exercises delete while nothing is running)
        for tok in users[:5]:
            closet = api("GET", "/api/closet", tok).json()
            for pk in closet:
                api("DELETE", f"/api/picks/{pk['id']}", tok)
    except Exception as e:  # noqa: BLE001
        check("(unexpected exception)", False, repr(e)[:400])
    finally:
        if proc:
            stop(proc)
        if log:
            log.close()
        gsrv.shutdown()
        for ph in uploaded_paths:
            if ph and ph.startswith("/uploads/"):
                try:
                    os.remove(os.path.join(ROOT, "uploads", ph[len("/uploads/"):]))
                except OSError:
                    pass
        shutil.rmtree(tmp, ignore_errors=True)

    npass = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n{npass}/{len(RESULTS)} checks passed")
    for name, ok, detail in RESULTS:
        if not ok:
            print(f"  FAIL {name}: {detail}")
    sys.exit(0 if npass == len(RESULTS) else 1)


if __name__ == "__main__":
    main()
