/**
 * Tiny client-side error log: a ring buffer of the last few window errors, unhandled promise
 * rejections and failed API calls. `getLastError()` flattens it into a compact string that the
 * "Report a problem" sheet sends along so we can see what went wrong without asking the user.
 *
 * Nothing here throws, and nothing is sent anywhere on its own.
 */

export type ErrorKind = "error" | "rejection" | "api";

export interface ErrorEntry {
  /** Epoch ms. */
  ts: number;
  kind: ErrorKind;
  message: string;
  /** Script URL for window errors, request URL for API failures, page hash otherwise. */
  url?: string;
  /** HTTP status for API failures. */
  status?: number;
}

const MAX_ENTRIES = 5;
const MAX_MESSAGE = 400;
const MAX_OUTPUT = 4000;

const buffer: ErrorEntry[] = [];
let installed = false;

function clip(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function describe(value: unknown): string {
  if (value == null) return "unknown";
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Push an entry, evicting the oldest once the buffer is full. */
export function recordError(entry: Omit<ErrorEntry, "ts"> & { ts?: number }): void {
  try {
    const e: ErrorEntry = { ts: entry.ts ?? Date.now(), kind: entry.kind, message: clip(entry.message || "unknown", MAX_MESSAGE) };
    if (entry.url) e.url = clip(entry.url, 300);
    if (typeof entry.status === "number") e.status = entry.status;
    buffer.push(e);
    while (buffer.length > MAX_ENTRIES) buffer.shift();
  } catch {
    /* never let logging break the app */
  }
}

/** Convenience for the API layer: a request that returned non-2xx or failed to reach the server. */
export function recordApiError(method: string, url: string, message: string, status?: number): void {
  // The feedback endpoint failing is reported to the user directly; don't let it pollute the next report.
  if (/\/api\/feedback(\?|$)/.test(url)) return;
  recordError({ kind: "api", message: `${method.toUpperCase()} ${status ?? "network"} — ${message}`, url, status });
}

/** Newest-last snapshot (copy). */
export function getErrorEntries(): ErrorEntry[] {
  return buffer.slice();
}

/** For tests / sign-out. */
export function clearErrorLog(): void {
  buffer.length = 0;
}

/**
 * Compact, newline-separated summary of recent errors, newest first, capped at 4000 chars.
 * Returns an empty string when nothing has gone wrong.
 */
export function getLastError(): string {
  if (!buffer.length) return "";
  const lines: string[] = [];
  for (let i = buffer.length - 1; i >= 0; i--) {
    const e = buffer[i];
    const when = new Date(e.ts).toISOString();
    const where = e.url ? ` @ ${e.url}` : "";
    lines.push(`[${when}] ${e.kind}: ${e.message}${where}`);
  }
  let out = lines.join("\n");
  if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT - 1)}…`;
  return out;
}

/** Attach window listeners exactly once. Safe to call from React StrictMode double-mounts. */
export function installErrorLog(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (ev: ErrorEvent) => {
    const msg = ev.error ? describe(ev.error) : ev.message || "Script error";
    const where = ev.filename ? `${ev.filename}:${ev.lineno ?? 0}:${ev.colno ?? 0}` : window.location.hash;
    recordError({ kind: "error", message: msg, url: where });
  });

  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    recordError({ kind: "rejection", message: describe(ev.reason), url: window.location.hash });
  });
}
