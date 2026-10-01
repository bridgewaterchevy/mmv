/**
 * "Report a problem" / "Suggest an idea" → GitHub issue.
 *
 * Per kind: problem → title "[Report] …", label user-report, heading "What happened";
 *           suggestion → title "[Idea] …", label suggestion, heading "The idea" (no "Last error"
 *           section unless one was captured).
 *
 * Enabled when GITHUB_ISSUES_TOKEN is set (fine-grained PAT with **Issues: Read and write** on the target
 * repo, see docs/RUNBOOK.md). GITHUB_ISSUES_REPO is "owner/repo" (default "bridgewaterchevy/mmv").
 * Filing is best-effort: callers must treat a `null` result as "saved locally, not filed". The token is
 * never logged.
 *
 * Test hooks:
 *   MOCK_GITHUB_ISSUES_URL  base URL that replaces https://api.github.com (a local mock server). A token
 *                           is not required when this is set.
 *   MOCK_GITHUB_ISSUE_JSON  canned response body; `{ "html_url": "..." }` succeeds, `{ "status": 500 }`
 *                           (any status ≥ 400) simulates an API failure. No network call is made.
 */
import type { Feedback, FeedbackKind, User } from "@shared/schema";

export const DEFAULT_ISSUES_REPO = "bridgewaterchevy/mmv";
/** Labels for kind=problem (kept for callers that predate `kind`). */
export const ISSUE_LABELS = ["user-report"];
export const ISSUE_LABELS_BY_KIND: Record<FeedbackKind, string[]> = { problem: ["user-report"], suggestion: ["suggestion"] };
export const ISSUE_TITLE_PREFIX: Record<FeedbackKind, string> = { problem: "[Report]", suggestion: "[Idea]" };
export const ISSUE_HEADING: Record<FeedbackKind, string> = { problem: "What happened", suggestion: "The idea" };

function kindOf(k: string | null | undefined): FeedbackKind {
  return k === "suggestion" ? "suggestion" : "problem";
}
export function issueLabels(kind: FeedbackKind | string | null | undefined = "problem"): string[] {
  return ISSUE_LABELS_BY_KIND[kindOf(kind)];
}
const API_TIMEOUT_MS = 15_000;

export interface IssueConfig {
  token: string | null;
  repo: string;
  apiBase: string;
}

export function issueConfig(env: NodeJS.ProcessEnv = process.env): IssueConfig | null {
  const token = env.GITHUB_ISSUES_TOKEN?.trim() || null;
  const mockUrl = env.MOCK_GITHUB_ISSUES_URL?.trim();
  if (!token && !mockUrl && !env.MOCK_GITHUB_ISSUE_JSON) return null;
  const repo = (env.GITHUB_ISSUES_REPO?.trim() || DEFAULT_ISSUES_REPO).replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error(`[github] GITHUB_ISSUES_REPO "${repo}" is not owner/repo; issue filing disabled`);
    return null;
  }
  return { token, repo, apiBase: (mockUrl || "https://api.github.com").replace(/\/+$/, "") };
}

export type Reporter = Pick<User, "id" | "name" | "handle">;

export function issueTitle(message: string, kind: FeedbackKind | string | null | undefined = "problem"): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  const head = oneLine.slice(0, 60);
  return `${ISSUE_TITLE_PREFIX[kindOf(kind)]} ${head}${oneLine.length > 60 ? "…" : ""}`;
}

/** Absolute URL for the screenshot when it is publicly reachable (Supabase public bucket, or APP_URL + local path). */
export function publicScreenshotUrl(screenshotPath: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!screenshotPath) return null;
  if (/^https?:\/\//i.test(screenshotPath)) return screenshotPath;
  const base = env.APP_URL?.trim().replace(/\/+$/, "");
  if (base && /^https?:\/\//i.test(base) && screenshotPath.startsWith("/")) return base + screenshotPath;
  return null;
}

const fence = (s: string) => "```\n" + s.replace(/```/g, "` ` `") + "\n```";

export function issueBody(report: Feedback, reporter: Reporter | null, env: NodeJS.ProcessEnv = process.env): string {
  const shot = publicScreenshotUrl(report.screenshotPath, env);
  const createdAt = report.createdAt instanceof Date ? report.createdAt.toISOString() : String(report.createdAt ?? new Date().toISOString());
  const kind = kindOf(report.kind);
  const lastError = report.lastError?.trim() ?? "";
  const lines: string[] = [
    `## ${ISSUE_HEADING[kind]}`,
    "",
    report.message.trim(),
    "",
    "## Context",
    "",
    `- **Reporter:** ${reporter ? `${reporter.name} @${reporter.handle} (user id ${reporter.id})` : `user id ${report.userId}`}`,
    `- **Page:** ${report.page?.trim() || "_not provided_"}`,
    `- **Device / user agent:** ${report.userAgent?.trim() || "_not provided_"}`,
    `- **App version:** ${report.appVersion?.trim() || "_not provided_"}`,
    `- **Timestamp:** ${createdAt}`,
    `- **Feedback id:** ${report.id}`,
    "",
  ];
  // Problems always get a "Last error" section; suggestions only when something was actually captured.
  if (kind === "problem" || lastError) lines.push("## Last error", "", lastError ? fence(lastError) : "_none captured_", "");
  lines.push(
    "## Screenshot",
    "",
    shot ? `![screenshot](${shot})\n\n${shot}` : report.screenshotPath ? `_attached, not publicly reachable_ (\`${report.screenshotPath}\`)` : "_none_",
    "",
    "---",
    kind === "suggestion" ? "_Filed automatically by MMV “Suggest an idea”._" : "_Filed automatically by MMV “Report a problem”._",
  );
  return lines.join("\n");
}

export interface IssueResult {
  url: string | null;
  /** Number of HTTP attempts made (2 when the labelled request failed and we retried without labels). */
  attempts: number;
  /** true when the final attempt omitted labels. */
  withoutLabels: boolean;
  error?: string;
}

interface GhResponse {
  status: number;
  body: Record<string, unknown>;
}

async function postIssue(cfg: IssueConfig, payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<GhResponse> {
  if (env.MOCK_GITHUB_ISSUE_JSON) {
    const body = JSON.parse(env.MOCK_GITHUB_ISSUE_JSON) as Record<string, unknown> & { status?: number };
    return { status: typeof body.status === "number" ? body.status : 201, body };
  }
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mmv-report-a-problem",
  };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const res = await fetch(`${cfg.apiBase}/repos/${cfg.repo}/issues`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error page */
  }
  return { status: res.status, body };
}

function describe(r: GhResponse): string {
  const msg = typeof r.body.message === "string" ? r.body.message : "";
  const errs = Array.isArray(r.body.errors) ? JSON.stringify(r.body.errors).slice(0, 200) : "";
  return `HTTP ${r.status}${msg ? ` ${msg}` : ""}${errs ? ` ${errs}` : ""}`;
}

/**
 * Create the issue. Never throws; never logs the token. If the labelled request is rejected
 * (e.g. 404/422 because the label cannot be applied), it is retried once without labels.
 */
export async function fileGithubIssue(report: Feedback, reporter: Reporter | null, env: NodeJS.ProcessEnv = process.env): Promise<IssueResult> {
  const cfg = issueConfig(env);
  if (!cfg) return { url: null, attempts: 0, withoutLabels: false, error: "not configured" };
  const base = { title: issueTitle(report.message, report.kind), body: issueBody(report, reporter, env) };
  try {
    let attempts = 1;
    let withoutLabels = false;
    let r = await postIssue(cfg, { ...base, labels: issueLabels(report.kind) }, env);
    if (r.status >= 400 && r.status !== 401 && r.status !== 403) {
      console.warn(`[github] issue with labels failed (${describe(r)}); retrying without labels`);
      attempts = 2;
      withoutLabels = true;
      r = await postIssue(cfg, base, env);
    }
    if (r.status >= 400) {
      const error = describe(r);
      console.error(`[github] could not file issue for feedback #${report.id} in ${cfg.repo}: ${error}`);
      return { url: null, attempts, withoutLabels, error };
    }
    const url = typeof r.body.html_url === "string" ? r.body.html_url : null;
    if (!url) {
      console.error(`[github] issue response for feedback #${report.id} had no html_url`);
      return { url: null, attempts, withoutLabels, error: "no html_url in response" };
    }
    console.log(`[github] filed ${url} for feedback #${report.id}`);
    return { url, attempts, withoutLabels };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[github] could not file issue for feedback #${report.id}: ${error}`);
    return { url: null, attempts: 1, withoutLabels: false, error };
  }
}
