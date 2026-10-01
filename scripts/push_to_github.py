#!/usr/bin/env python3
"""
push_to_github.py - publish the current working tree of this git repo to GitHub
using only the REST API (no `git push`, no SSH keys, no stored token).

Why the REST API?  In the sandbox the GitHub token is injected by an HTTPS proxy
for requests to api.github.com, so plain `git push` may not be authenticated.
This script talks to api.github.com with `requests`, which honours
HTTPS_PROXY / REQUESTS_CA_BUNDLE from the environment automatically.  It never
sets an Authorization header itself (the proxy does), unless GITHUB_TOKEN is
explicitly exported - handy for running it on a laptop.

What it does
  1. GET  /repos/{owner}/{repo}            -> does the repo exist?
     POST /user/repos  (or /orgs/{owner}/repos)   -> create it if not
  2. GET  /repos/{o}/{r}/git/ref/heads/{branch}    -> current head (if any)
  3. POST /repos/{o}/{r}/git/blobs          -> one blob per file (base64)
  4. POST /repos/{o}/{r}/git/trees          -> one full tree (snapshot)
  5. POST /repos/{o}/{r}/git/commits        -> commit on top of head
  6. PATCH/POST /repos/{o}/{r}/git/refs     -> move/create the branch

Files pushed = `git ls-files` + `git ls-files --others --exclude-standard`,
minus anything .gitignore'd, minus node_modules/dist/data/uploads/.env*, minus
files > 25 MB, minus files deleted from disk.  (.env.example is kept.)

Usage
  GITHUB_OWNER=<login> GITHUB_REPO=<name> python3 scripts/push_to_github.py "commit message"
  python3 scripts/push_to_github.py --dry-run          # list files only, no network

Env vars
  GITHUB_OWNER   (required unless --owner)  GitHub login or org that owns the repo
  GITHUB_REPO    (required unless --repo)   repository name
  GITHUB_BRANCH  (default: main)
  GITHUB_PRIVATE (default: false)           "true"/"1" to create a private repo
  GITHUB_API_URL (default: https://api.github.com)
  GITHUB_TOKEN   (optional)                 only needed OUTSIDE the sandbox proxy
"""

from __future__ import annotations

import argparse
import base64
import fnmatch
import hashlib
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("python 'requests' is required: pip install requests")

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
MAX_FILE_BYTES = 25 * 1024 * 1024  # 25 MB hard ceiling (GitHub blob API max is 100 MB)

# Any path whose FIRST component (or any component) matches these is skipped,
# even if git happens to track it.
SKIP_DIRS = {"node_modules", "dist", "data", "uploads", ".git", "__pycache__", ".pytest_cache"}
# Exact basenames / suffixes to skip.
SKIP_BASENAMES = {"dev.log", "prod.log", ".DS_Store"}
SKIP_SUFFIXES = (".pyc", ".pyo", ".db", ".db-shm", ".db-wal", ".sqlite", ".sqlite3")
# Secrets: skip any ".env" or ".env.<something>" EXCEPT ".env.example".
ENV_KEEP = {".env.example", ".env.sample", ".env.template"}

API_VERSION = "2022-11-28"
USER_AGENT = "mmv-push-to-github/1.0 (+python-requests)"


def log(msg: str) -> None:
    print(msg, flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


# --------------------------------------------------------------------------- #
# Git helpers (local only)
# --------------------------------------------------------------------------- #
def git(repo_root: Path, *args: str) -> str:
    out = subprocess.run(
        ["git", "-C", str(repo_root), *args],
        check=True,
        capture_output=True,
    )
    return out.stdout.decode("utf-8", "surrogateescape")


def git_z(repo_root: Path, *args: str) -> list[str]:
    """Run a git command with -z and return the NUL-separated list."""
    raw = subprocess.run(
        ["git", "-C", str(repo_root), *args, "-z"], check=True, capture_output=True
    ).stdout
    return [p.decode("utf-8", "surrogateescape") for p in raw.split(b"\0") if p]


def is_env_secret(name: str) -> bool:
    return (name == ".env" or name.startswith(".env.")) and name not in ENV_KEEP


def classify_skip(rel: str, repo_root: Path) -> str | None:
    """Return a reason string if the path must be skipped, else None."""
    parts = rel.split("/")
    for p in parts:
        if p in SKIP_DIRS:
            return f"in skipped dir '{p}'"
    base = parts[-1]
    if base in SKIP_BASENAMES:
        return "log/junk file"
    if base.endswith(SKIP_SUFFIXES):
        return "bytecode/database file"
    if is_env_secret(base):
        return "env/secret file"
    full = repo_root / rel
    if not full.exists() and not full.is_symlink():
        return "deleted from disk"
    if full.is_dir():
        return "directory (submodule?)"
    if not full.is_symlink():
        size = full.stat().st_size
        if size > MAX_FILE_BYTES:
            return f"too large ({size / 1024 / 1024:.1f} MB > 25 MB)"
    return None


def collect_files(repo_root: Path, skip_workflows: bool = False, excludes: list[str] | None = None):
    """Return (kept, skipped) where kept = [(relpath, size, mode)], skipped = [(relpath, reason)]."""
    tracked = git_z(repo_root, "ls-files")
    untracked = git_z(repo_root, "ls-files", "--others", "--exclude-standard")
    candidates = sorted(set(tracked) | set(untracked))

    # Honour .gitignore even for files git already tracks (e.g. a stray prod.log).
    ignored: set[str] = set()
    if candidates:
        proc = subprocess.run(
            ["git", "-C", str(repo_root), "check-ignore", "--no-index", "-z", "--stdin"],
            input="\0".join(candidates).encode("utf-8", "surrogateescape"),
            capture_output=True,
        )
        # exit 0 = some ignored, 1 = none ignored, 128 = error
        if proc.returncode in (0, 1):
            ignored = {
                p.decode("utf-8", "surrogateescape")
                for p in proc.stdout.split(b"\0")
                if p
            }

    kept, skipped = [], []
    for rel in candidates:
        if rel in ignored:
            skipped.append((rel, "matches .gitignore"))
            continue
        reason = classify_skip(rel, repo_root)
        if reason:
            skipped.append((rel, reason))
            continue
        if skip_workflows and rel.startswith(".github/workflows/"):
            skipped.append((rel, "--skip-workflows"))
            continue
        if excludes and any(fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(rel.split("/")[0], pat.rstrip("/")) for pat in excludes):
            skipped.append((rel, "--exclude"))
            continue
        full = repo_root / rel
        if full.is_symlink():
            mode = "120000"
            size = len(os.readlink(full).encode())
        else:
            st = full.stat()
            mode = "100755" if (st.st_mode & 0o111) else "100644"
            size = st.st_size
        kept.append((rel, size, mode))
    return kept, skipped


def read_blob(repo_root: Path, rel: str, mode: str) -> bytes:
    full = repo_root / rel
    if mode == "120000":
        return os.readlink(full).encode()
    return full.read_bytes()


def git_blob_sha(data: bytes) -> str:
    h = hashlib.sha1()
    h.update(f"blob {len(data)}\0".encode())
    h.update(data)
    return h.hexdigest()


# --------------------------------------------------------------------------- #
# GitHub API client
# --------------------------------------------------------------------------- #
class GitHub:
    def __init__(self, api_url: str):
        self.api = api_url.rstrip("/")
        self.s = requests.Session()
        # Python 3.13 enforces VERIFY_X509_STRICT; the sandbox HTTPS proxy CA lacks a key-usage
        # extension, so relax only that flag (certificate chain is still verified).
        try:
            import ssl
            from requests.adapters import HTTPAdapter
            class _Adapter(HTTPAdapter):
                def init_poolmanager(self, *a, **kw):
                    ctx = ssl.create_default_context()
                    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
                    kw["ssl_context"] = ctx
                    return super().init_poolmanager(*a, **kw)
                def proxy_manager_for(self, *a, **kw):
                    ctx = ssl.create_default_context()
                    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
                    kw["ssl_context"] = ctx
                    return super().proxy_manager_for(*a, **kw)
            self.s.mount("https://", _Adapter())
        except Exception:
            pass
        self.s.headers.update(
            {
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": API_VERSION,
                "User-Agent": USER_AGENT,
            }
        )
        # Only set auth ourselves when running outside the proxy.
        tok = os.environ.get("GITHUB_TOKEN")
        if tok:
            self.s.headers["Authorization"] = f"Bearer {tok}"
        # requests picks up HTTPS_PROXY / REQUESTS_CA_BUNDLE on its own.
        self.s.trust_env = True

    def req(self, method: str, path: str, ok=(200, 201), retries: int = 4, **kw):
        url = path if path.startswith("http") else f"{self.api}{path}"
        kw.setdefault("timeout", 60)
        last = None
        for attempt in range(retries):
            r = self.s.request(method, url, **kw)
            last = r
            if r.status_code in ok:
                return r
            # Rate limit / abuse / transient server errors -> back off and retry.
            if r.status_code in (403, 429) and (
                r.headers.get("Retry-After") or "rate limit" in r.text.lower()
            ):
                wait = int(r.headers.get("Retry-After") or 0) or min(60, 5 * (attempt + 1))
                log(f"  rate limited on {method} {path}; sleeping {wait}s")
                time.sleep(wait)
                continue
            if r.status_code >= 500:
                time.sleep(2 * (attempt + 1))
                continue
            break
        return last  # caller decides

    def check(self, r: requests.Response, what: str):
        """Exit with a helpful message if the response is an error; otherwise no-op."""
        if r is None:
            die(f"{what}: no response")
        if r.status_code < 400:
            return
        try:
            body = r.json()
        except ValueError:
            body = r.text[:500]
        msg = body.get("message") if isinstance(body, dict) else body
        accepted = r.headers.get("X-Accepted-GitHub-Permissions")
        hint = ""
        if r.status_code in (401,):
            hint = (
                "\n  -> 401: the request was not authenticated. In the sandbox this means the "
                "credential proxy did not inject the token (check api_credentials / HTTPS_PROXY)."
            )
        elif r.status_code in (403, 404):
            hint = (
                "\n  -> 403/404 usually means the token lacks a permission or the token's "
                "'Repository access' does not include this repo. See docs/GITHUB.md."
            )
            if accepted:
                hint += f"\n  -> GitHub says this endpoint accepts: {accepted}"
            if "workflow" in str(msg).lower():
                hint += (
                    "\n  -> The repo contains .github/workflows/*. A fine-grained token needs "
                    "'Workflows: Read and write' to push those, or re-run with --skip-workflows."
                )
        die(f"{what} failed: HTTP {r.status_code}: {msg}{hint}")


# --------------------------------------------------------------------------- #
# Main flow
# --------------------------------------------------------------------------- #
def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("message", nargs="?", default="Import MMV app from sandbox", help="commit message")
    p.add_argument("--owner", default=os.environ.get("GITHUB_OWNER"), help="GitHub login/org (env GITHUB_OWNER)")
    p.add_argument("--repo", default=os.environ.get("GITHUB_REPO"), help="repository name (env GITHUB_REPO)")
    p.add_argument("--branch", default=os.environ.get("GITHUB_BRANCH", "main"), help="branch (env GITHUB_BRANCH, default main)")
    vis = p.add_mutually_exclusive_group()
    vis.add_argument("--private", dest="private", action="store_true", help="create repo as private")
    vis.add_argument("--public", dest="private", action="store_false", help="create repo as public (default)")
    p.set_defaults(private=os.environ.get("GITHUB_PRIVATE", "false").strip().lower() in ("1", "true", "yes"))
    p.add_argument("--description", default="MMV (Match My Vibe) - Node/Express + React app", help="repo description used on creation")
    p.add_argument("--repo-root", default=None, help="path to the git repo (default: parent of scripts/)")
    p.add_argument("--api-url", default=os.environ.get("GITHUB_API_URL", "https://api.github.com"))
    p.add_argument("--workers", type=int, default=4, help="parallel blob uploads (default 4)")
    p.add_argument("--skip-workflows", action="store_true", help="do not push .github/workflows/* (if token lacks Workflows permission)")
    p.add_argument("--exclude", action="append", default=[], metavar="GLOB", help="extra glob to skip, repeatable (e.g. --exclude 'qa/*.png' --exclude tests)")
    p.add_argument("--force", action="store_true", help="force-update the branch ref (non fast-forward)")
    p.add_argument("--dry-run", action="store_true", help="list files + sizes and exit; makes NO network calls")
    p.add_argument("-v", "--verbose", action="store_true", help="also list skipped files with reasons")
    return p.parse_args(argv)


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n} B"


def main(argv: list[str]) -> int:
    a = parse_args(argv)
    repo_root = Path(a.repo_root).resolve() if a.repo_root else Path(__file__).resolve().parent.parent
    if not (repo_root / ".git").exists():
        die(f"{repo_root} is not a git repository (no .git)")

    kept, skipped = collect_files(repo_root, skip_workflows=a.skip_workflows, excludes=a.exclude)
    total = sum(s for _, s, _ in kept)

    # ---------------- dry run ----------------
    if a.dry_run:
        log(f"Repo root : {repo_root}")
        log(f"Target    : {a.owner or '<GITHUB_OWNER unset>'}/{a.repo or '<GITHUB_REPO unset>'} @ {a.branch} ({'private' if a.private else 'public'})")
        log(f"Message   : {a.message}")
        log("")
        log(f"{'size':>10}  mode    path")
        for rel, size, mode in kept:
            log(f"{human(size):>10}  {mode}  {rel}")
        log("")
        log(f"{len(kept)} files, {human(total)} total would be pushed.")
        log(f"{len(skipped)} paths skipped" + (" (use -v to list)" if skipped and not a.verbose else ""))
        if a.verbose:
            for rel, why in skipped:
                log(f"   skip  {rel}  [{why}]")
        has_wf = any(r.startswith(".github/workflows/") for r, _, _ in kept)
        if has_wf:
            log("\nNote: .github/workflows/* is included -> a fine-grained token also needs 'Workflows: Read and write'.")
        return 0

    # ---------------- real run ----------------
    if not a.owner or not a.repo:
        die("GITHUB_OWNER and GITHUB_REPO must be set (or pass --owner/--repo)")
    if not kept:
        die("nothing to push")

    gh = GitHub(a.api_url)
    o, r, br = a.owner, a.repo, a.branch

    # Who am I? (also verifies the proxy/token works before doing anything else)
    me = gh.req("GET", "/user")
    gh.check(me, "GET /user (token check)")
    login = me.json().get("login")
    log(f"Authenticated as: {login}")

    # 1. repo exists?
    rr = gh.req("GET", f"/repos/{o}/{r}", ok=(200, 404))
    if rr.status_code == 200:
        repo_json = rr.json()
        created = False
        log(f"Repo exists: {repo_json['html_url']}")
    else:
        if rr.status_code != 404:
            gh.check(rr, f"GET /repos/{o}/{r}")
        payload = {
            "name": r,
            "description": a.description,
            "private": bool(a.private),
            "auto_init": False,
            "has_wiki": False,
        }
        if login and o.lower() == login.lower():
            cr = gh.req("POST", "/user/repos", json=payload, ok=(201,))
            gh.check(cr, "POST /user/repos (create repository)")
        else:
            cr = gh.req("POST", f"/orgs/{o}/repos", json=payload, ok=(201,))
            gh.check(cr, f"POST /orgs/{o}/repos (create repository)")
        repo_json = cr.json()
        created = True
        log(f"Created repo: {repo_json['html_url']} ({'private' if repo_json.get('private') else 'public'})")
        # Freshly created repos can take a moment before Git Data endpoints accept writes.
        time.sleep(2)

    base = f"/repos/{o}/{r}"

    # 2. current branch head (if any)
    parent_sha = None
    base_tree_entries: dict[str, str] = {}
    ref = gh.req("GET", f"{base}/git/ref/heads/{br}", ok=(200, 404, 409))
    if ref.status_code == 200:
        parent_sha = ref.json()["object"]["sha"]
        log(f"Branch '{br}' exists at {parent_sha[:10]}; new commit will be its child.")
        c = gh.req("GET", f"{base}/git/commits/{parent_sha}")
        gh.check(c, "GET parent commit")
        tree_sha = c.json()["tree"]["sha"]
        t = gh.req("GET", f"{base}/git/trees/{tree_sha}", params={"recursive": "1"})
        if t.status_code == 200 and not t.json().get("truncated"):
            base_tree_entries = {e["path"]: e["sha"] for e in t.json().get("tree", []) if e["type"] == "blob"}
    else:
        # 404 = branch missing, 409 = repo is empty.  Either way: root commit.
        log(f"Branch '{br}' does not exist yet; creating it with a root commit.")

    # 3. blobs
    log(f"Uploading {len(kept)} files ({human(total)})...")
    entries: list[dict] = []
    todo: list[tuple[str, str, bytes, str]] = []
    reused = 0
    for rel, _size, mode in kept:
        data = read_blob(repo_root, rel, mode)
        sha = git_blob_sha(data)
        if base_tree_entries.get(rel) == sha:
            entries.append({"path": rel, "mode": mode, "type": "blob", "sha": sha})
            reused += 1
        else:
            todo.append((rel, mode, data, sha))
    if reused:
        log(f"  {reused} unchanged files reused from the existing tree.")

    def upload(item):
        rel, mode, data, local_sha = item
        body = {"content": base64.b64encode(data).decode("ascii"), "encoding": "base64"}
        resp = gh.req("POST", f"{base}/git/blobs", json=body, ok=(201,))
        if resp is None or resp.status_code != 201:
            return rel, mode, None, resp
        remote_sha = resp.json()["sha"]
        if remote_sha != local_sha:
            # Should never happen; flag loudly but keep going with GitHub's sha.
            log(f"  WARNING sha mismatch for {rel}: local {local_sha[:8]} remote {remote_sha[:8]}")
        return rel, mode, remote_sha, resp

    done = 0
    with ThreadPoolExecutor(max_workers=max(1, a.workers)) as ex:
        futs = [ex.submit(upload, it) for it in todo]
        for f in as_completed(futs):
            rel, mode, sha, resp = f.result()
            if sha is None:
                gh.check(resp, f"POST git/blobs for {rel}")
            entries.append({"path": rel, "mode": mode, "type": "blob", "sha": sha})
            done += 1
            if done % 25 == 0 or done == len(todo):
                log(f"  {done}/{len(todo)} blobs uploaded")

    # 4. tree (full snapshot, so deletions are honoured)
    entries.sort(key=lambda e: e["path"])
    tr = gh.req("POST", f"{base}/git/trees", json={"tree": entries}, ok=(201,))
    gh.check(tr, "POST git/trees")
    tree_sha = tr.json()["sha"]
    log(f"Tree: {tree_sha[:10]}")

    if parent_sha and base_tree_entries and reused == len(kept) and len(base_tree_entries) == len(kept):
        log("Nothing changed compared to the branch head; no new commit created.")
        log(f"Branch URL: https://github.com/{o}/{r}/tree/{br}")
        return 0

    # 5. commit
    commit_body = {"message": a.message, "tree": tree_sha, "parents": [parent_sha] if parent_sha else []}
    cm = gh.req("POST", f"{base}/git/commits", json=commit_body, ok=(201,))
    gh.check(cm, "POST git/commits")
    commit_sha = cm.json()["sha"]
    log(f"Commit: {commit_sha}")

    # 6. ref
    if parent_sha:
        up = gh.req("PATCH", f"{base}/git/refs/heads/{br}", json={"sha": commit_sha, "force": bool(a.force)}, ok=(200,))
        gh.check(up, f"PATCH git/refs/heads/{br}")
    else:
        up = gh.req("POST", f"{base}/git/refs", json={"ref": f"refs/heads/{br}", "sha": commit_sha}, ok=(201,))
        gh.check(up, "POST git/refs")

    # Make sure the branch we pushed is the default branch for a brand-new repo.
    if created and repo_json.get("default_branch") and repo_json["default_branch"] != br:
        pd = gh.req("PATCH", base, json={"default_branch": br}, ok=(200,))
        if pd is None or pd.status_code != 200:
            log(f"  (could not set default branch to '{br}'; set it in repo Settings if needed)")

    html = repo_json.get("html_url", f"https://github.com/{o}/{r}")
    log("")
    log(f"Pushed {len(kept)} files to {html} (branch {br})")
    log(f"Commit URL: {html}/commit/{commit_sha}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except subprocess.CalledProcessError as e:
        die(f"git command failed: {e.cmd}\n{e.stderr.decode(errors='replace')}")
    except KeyboardInterrupt:
        die("interrupted", 130)
