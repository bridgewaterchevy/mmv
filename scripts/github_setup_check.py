#!/usr/bin/env python3
"""
github_setup_check.py - confirm the GitHub token/proxy works before pushing.

Calls   GET https://api.github.com/user
and     GET https://api.github.com/user/repos?per_page=5
and prints the login plus a few repo names.  The token itself is never printed.

Auth: no Authorization header is added here - in the sandbox an HTTPS proxy
injects it for api.github.com (requests honours HTTPS_PROXY/REQUESTS_CA_BUNDLE).
Outside the sandbox, export GITHUB_TOKEN and it will be used as a Bearer token.

Exit code 0 = good to go, 1 = something is wrong (message explains what).
"""

from __future__ import annotations

import os
import sys

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("python 'requests' is required: pip install requests")

API = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")


def main() -> int:
    s = requests.Session()
    s.trust_env = True
    s.headers.update(
        {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "mmv-github-setup-check/1.0",
        }
    )
    tok = os.environ.get("GITHUB_TOKEN")
    if tok:
        s.headers["Authorization"] = f"Bearer {tok}"
        print("Using GITHUB_TOKEN from environment (value not shown).")
    else:
        print("No GITHUB_TOKEN in env; relying on the credential proxy to add auth.")

    try:
        r = s.get(f"{API}/user", timeout=30)
    except requests.RequestException as e:
        print(f"FAIL: network error talking to {API}: {e.__class__.__name__}: {e}")
        return 1

    if r.status_code == 401:
        print("FAIL: 401 Unauthorized - no/invalid token reached GitHub.")
        print("      In the sandbox: was the bash call made with the github api_credentials handle?")
        print("      On a laptop: is GITHUB_TOKEN exported and not expired?")
        return 1
    if r.status_code != 200:
        print(f"FAIL: GET /user -> HTTP {r.status_code}: {r.text[:300]}")
        return 1

    u = r.json()
    print(f"OK: authenticated as '{u.get('login')}' (account type: {u.get('type')}, id {u.get('id')})")

    # Fine-grained tokens expose their permissions only indirectly; classic tokens expose scopes.
    scopes = r.headers.get("X-OAuth-Scopes")
    if scopes is not None:
        print(f"    classic token scopes: {scopes or '(none)'}")
    else:
        print("    token type: fine-grained PAT or GitHub App token (no scope header)")
    exp = r.headers.get("GitHub-Authentication-Token-Expiration")
    if exp:
        print(f"    token expires: {exp}")

    r2 = s.get(f"{API}/user/repos", params={"per_page": 5, "sort": "updated"}, timeout=30)
    if r2.status_code != 200:
        print(f"WARN: GET /user/repos -> HTTP {r2.status_code}: {r2.text[:200]}")
        print("      (Fine-grained tokens need 'Metadata: read' - granted automatically with any repo permission.)")
        return 1
    repos = r2.json()
    if repos:
        print(f"    {len(repos)} most recently updated repos visible to this token:")
        for rp in repos:
            print(f"      - {rp['full_name']} ({'private' if rp.get('private') else 'public'})")
    else:
        print("    no repositories visible yet (fine for a brand-new account).")

    rl = r2.headers.get("X-RateLimit-Remaining")
    if rl:
        print(f"    API rate limit remaining: {rl}")
    print("Token check passed. Next: python3 scripts/push_to_github.py --dry-run")
    return 0


if __name__ == "__main__":
    sys.exit(main())
