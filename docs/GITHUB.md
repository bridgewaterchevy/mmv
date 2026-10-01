# Getting MMV into your GitHub account

This guide is for someone who has **just created a GitHub account** and has never used
Git. You will create one access token on github.com; the assistant then runs two small
scripts in `scripts/` that create the repository and upload the code for you. Nothing
is installed on your Mac.

Time needed: about 5 minutes.

---

## 1. Create the token (macOS, Safari or Chrome)

A *fine-grained personal access token* is a password that only lets the scripts do a
few specific things. Follow these steps exactly.

### Fast path (pre-filled form)

1. Make sure your GitHub email address is verified (GitHub nags you at the top of the
   page until it is).
2. Click this link while signed in to GitHub — it opens the token form with the right
   settings already filled in:

   ```
   https://github.com/settings/personal-access-tokens/new?name=MMV+upload&description=Lets+the+MMV+scripts+create+the+repo+and+push+code&expires_in=90&administration=write&contents=write&workflows=write
   ```

3. Check the form matches the table in step 11 below, then click **Generate token**.
4. Copy the token (it starts with `github_pat_`). GitHub only shows it once.
5. Paste it into the secure credential form the assistant gave you. Do **not** paste it
   into the chat, an email, or a note.

### Manual path (if the link doesn't pre-fill)

1. In the upper-right corner of any GitHub page, click your **profile picture**, then
   **Settings**.
2. Scroll the left sidebar to the very bottom and click **Developer settings**.
3. In the left sidebar, under **Personal access tokens**, click **Fine-grained tokens**.
4. Click **Generate new token**.
5. **Token name**: `MMV upload`.
6. **Expiration**: choose **Custom** and pick the date 90 days from today (or pick
   **90 days** if it's offered in the dropdown).
7. **Description** (optional): `Lets the MMV scripts create the repo and push code`.
8. **Resource owner**: leave it as your own username.
9. **Repository access**: select **All repositories**.
   Why: the repository doesn't exist yet, so you can't pick it under "Only select
   repositories". After the first push you may edit the token and narrow it to just
   the MMV repo.
10. Click **Repository permissions** to expand the list.
11. Set exactly these three; leave everything else at **No access**:

    | Permission | Value | Why the script needs it |
    |---|---|---|
    | **Administration** | Read and write | Create the repository (`POST /user/repos`) |
    | **Contents** | Read and write | Upload files, create the commit, move the `main` branch |
    | **Workflows** | Read and write | The code contains `.github/workflows/keep-alive.yml`; pushing a workflow file needs this |

    *Metadata: Read-only* turns itself on automatically — that's expected.
    *Account permissions* can all stay at No access.
12. Click **Generate token**, copy the `github_pat_...` value, and paste it into the
    secure credential form.

Those steps follow GitHub's own instructions in
[Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens),
which also documents the pre-fill URL parameters used in the fast-path link
(`administration`, `contents`, `workflows`, `expires_in`).

### Why these permissions (for the curious)

- GitHub's REST reference for
  [Create a repository for the authenticated user](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user)
  says fine-grained tokens **can** create repos: the token needs *either*
  "Administration" repository permission (write) *or* the newer "Repository creation"
  repository permission (write). A classic token is **not** required (for classic tokens
  the scope would be `public_repo` for a public repo or `repo` for a private one).
- The same mapping appears in
  [Permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens),
  which lists `POST /user/repos` under both "Administration" and "Repository creation",
  the Git Data endpoints (`git/blobs`, `git/trees`, `git/commits`, `git/refs`) under
  "Contents" (write), and `git/refs` additionally under "Workflows" when workflow files
  are involved. `GET /user` needs no permission at all
  ([Users API](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)).
- If your token form shows a **Repository creation** permission, you may pick that
  instead of Administration — it is narrower. The pre-filled link uses Administration
  because it is guaranteed to exist on every account.

---

## 2. What the assistant runs

```bash
# 1) confirm the token works - prints your login, never the token
python3 scripts/github_setup_check.py

# 2) preview exactly which files would be uploaded (no network)
python3 scripts/push_to_github.py --dry-run

# 3) create the repo (public by default) and push everything as one commit
GITHUB_OWNER=<your-username> GITHUB_REPO=mmv python3 scripts/push_to_github.py "Initial import of MMV"
```

Options: `GITHUB_PRIVATE=true` (or `--private`) for a private repo; `GITHUB_BRANCH`
(default `main`); `--exclude 'qa/*'` to leave out the QA screenshots; `--skip-workflows`
if you did not grant the Workflows permission.

The script never uploads `node_modules`, `dist`, `data/`, `uploads/`, `.env` files,
logs, or anything over 25 MB. Re-running it later adds a new commit on top of the
existing branch and only uploads files that changed.

---

## 3. Fallback: if the token can't create the repository

Symptoms: the script stops with `POST /user/repos ... HTTP 403` (or 404). Create the
empty repository yourself, then the script only has to push.

1. Go to <https://github.com/new> (or click the **+** in the upper-right corner, then
   **New repository**).
2. **Repository name**: `mmv` (or whatever you told the assistant).
3. **Description**: optional.
4. Choose **Public** or **Private**.
5. Leave **Add a README file** switched **off**, and leave `.gitignore` and
   license as **None** — the repository must stay empty so the script's first commit
   becomes the start of history.
6. Click **Create repository**. Ignore the "Quick setup" instructions page.
7. Tell the assistant it exists; it re-runs `push_to_github.py` with the same
   `GITHUB_OWNER` / `GITHUB_REPO` and the script detects the repo and pushes.

(These are GitHub's steps from the
[Quickstart for repositories](https://docs.github.com/en/repositories/creating-and-managing-repositories/quickstart-for-repositories),
minus the README toggle.)

If you created the token with **Only select repositories**, edit the token afterwards
(Settings → Developer settings → Fine-grained tokens → your token) and add the new repo
under *Selected repositories*, otherwise the push will get a 404.

---

## 4. Afterwards

- Open `https://github.com/<your-username>/mmv` — you should see the files and one commit.
- When you're done deploying, you can **delete or shorten** the token under
  Settings → Developer settings → Fine-grained tokens. The token expires on its own
  after 90 days anyway.
- If anything says `401`, the token didn't reach GitHub (wrong paste or expired). If it
  says `403` with a message about workflows, the Workflows permission is missing.
