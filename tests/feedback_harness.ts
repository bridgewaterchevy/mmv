/**
 * Node-side harness driven by tests/test_feedback_mock.py:
 *   MOCK_GITHUB_ISSUES_URL=http://127.0.0.1:<port> GITHUB_ISSUES_TOKEN=... npx tsx tests/feedback_harness.ts
 * Exercises server/github.ts (title/body rendering, label retry, failure handling, canned-response hook)
 * in ONE process and prints a single JSON document for the Python test to assert on. The mock GitHub
 * server decides the behaviour from the repo name (mock/ok, mock/labelfail, mock/fail, mock/auth).
 */
import { fileGithubIssue, issueTitle, issueBody, issueConfig, publicScreenshotUrl, DEFAULT_ISSUES_REPO, ISSUE_LABELS } from "../server/github";
import { adminHandles, isAdmin } from "../server/feedback";
import type { Feedback } from "../shared/schema";

const out: Record<string, unknown> = {};

const report: Feedback = {
  id: 42,
  userId: 7,
  message: "The upload button does nothing on iOS Safari when I pick a HEIC photo.\n\nTried twice.",
  page: "/crews/3/day/2026-10-01",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1",
  appVersion: "1.4.2",
  lastError: 'TypeError: Cannot read properties of undefined (reading "size")\n    at upload (app.js:12:3)\n```not a fence```',
  screenshotPath: "https://proj.supabase.co/storage/v1/object/public/outfits/feedback/42.png",
  githubIssueUrl: null,
  status: "open",
  createdAt: new Date("2026-10-01T21:36:00.000Z"),
};
const reporter = { id: 7, name: "Jane Doe", handle: "janed" };

async function main() {
  const env = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, ...overrides };
    for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete e[k];
    return e;
  };

  // ---- pure rendering
  out.titles = {
    long: issueTitle("x".repeat(100)),
    short: issueTitle("  Button   broken\non load "),
    exact60: issueTitle("a".repeat(60)),
  };
  out.body = issueBody(report, reporter);
  out.bodyNoReporter = issueBody({ ...report, lastError: null, screenshotPath: null, page: null }, null);
  out.bodyLocalShotNoAppUrl = issueBody({ ...report, screenshotPath: "/uploads/feedback/42.png" }, reporter, env({ APP_URL: undefined }));
  out.bodyLocalShotAppUrl = issueBody({ ...report, screenshotPath: "/uploads/feedback/42.png" }, reporter, env({ APP_URL: "https://mmv.onrender.com/" }));
  out.publicUrl = {
    absolute: publicScreenshotUrl("https://x.supabase.co/storage/v1/object/public/outfits/feedback/1.png"),
    localNoBase: publicScreenshotUrl("/uploads/feedback/1.png", env({ APP_URL: undefined })),
    localBase: publicScreenshotUrl("/uploads/feedback/1.png", env({ APP_URL: "https://mmv.onrender.com" })),
    none: publicScreenshotUrl(null),
  };

  // ---- config
  out.config = {
    none: issueConfig(env({ GITHUB_ISSUES_TOKEN: undefined, MOCK_GITHUB_ISSUES_URL: undefined, MOCK_GITHUB_ISSUE_JSON: undefined })),
    defaultRepo: issueConfig(env({ GITHUB_ISSUES_TOKEN: "t", GITHUB_ISSUES_REPO: undefined, MOCK_GITHUB_ISSUES_URL: undefined }))?.repo,
    constDefault: DEFAULT_ISSUES_REPO,
    urlRepo: issueConfig(env({ GITHUB_ISSUES_TOKEN: "t", GITHUB_ISSUES_REPO: "https://github.com/foo/bar/" }))?.repo,
    badRepo: issueConfig(env({ GITHUB_ISSUES_TOKEN: "t", GITHUB_ISSUES_REPO: "not a repo" })),
    labels: ISSUE_LABELS,
  };

  // ---- against the mock server
  out.ok = await fileGithubIssue(report, reporter, env({ GITHUB_ISSUES_REPO: "mock/ok" }));
  out.labelRetry = await fileGithubIssue(report, reporter, env({ GITHUB_ISSUES_REPO: "mock/labelfail" }));
  out.fail = await fileGithubIssue(report, reporter, env({ GITHUB_ISSUES_REPO: "mock/fail" }));
  out.auth = await fileGithubIssue(report, reporter, env({ GITHUB_ISSUES_REPO: "mock/auth" }));
  out.noHtmlUrl = await fileGithubIssue(report, reporter, env({ GITHUB_ISSUES_REPO: "mock/nourl" }));
  out.notConfigured = await fileGithubIssue(report, reporter, env({ GITHUB_ISSUES_TOKEN: undefined, MOCK_GITHUB_ISSUES_URL: undefined, MOCK_GITHUB_ISSUE_JSON: undefined }));
  // unreachable host: must resolve (not throw) with url null
  out.network = await fileGithubIssue(report, reporter, env({ MOCK_GITHUB_ISSUES_URL: "http://127.0.0.1:9", GITHUB_ISSUES_REPO: "mock/ok" }));

  // ---- canned-response hook (no network)
  out.cannedOk = await fileGithubIssue(report, reporter, env({ MOCK_GITHUB_ISSUES_URL: undefined, MOCK_GITHUB_ISSUE_JSON: JSON.stringify({ html_url: "https://github.com/canned/repo/issues/9" }) }));
  out.cannedFail = await fileGithubIssue(report, reporter, env({ MOCK_GITHUB_ISSUES_URL: undefined, MOCK_GITHUB_ISSUE_JSON: JSON.stringify({ status: 503, message: "down" }) }));

  // ---- admin gating helpers
  out.admins = {
    parsed: Array.from(adminHandles({ ADMIN_HANDLES: " Jane , @Bob,,bridgewaterchevy " })),
    yes: isAdmin({ handle: "JANE" }, { ADMIN_HANDLES: "jane,bob" }),
    no: isAdmin({ handle: "janet" }, { ADMIN_HANDLES: "jane,bob" }),
    empty: isAdmin({ handle: "jane" }, { ADMIN_HANDLES: "" }),
    unset: isAdmin({ handle: "jane" }, {}),
  };

  console.log(JSON.stringify(out));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
