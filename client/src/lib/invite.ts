// Invite deep links, share text, PWA install detection and the "shop for" preference.
// Kept free of React so both the auth provider and pages can use it.

const PENDING_KEY = "mmv.pendingInvite";

function safeStorage(): Storage | null {
  try {
    const s = window.localStorage;
    s.getItem(PENDING_KEY);
    return s;
  } catch {
    return null;
  }
}

let memoryPending: string | null = null;

export function normalizeInviteCode(raw: string | null | undefined): string | null {
  const code = (raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length >= 4 && code.length <= 12 ? code : null;
}

export function getPendingInvite(): string | null {
  if (memoryPending) return memoryPending;
  memoryPending = normalizeInviteCode(safeStorage()?.getItem(PENDING_KEY));
  return memoryPending;
}

export function setPendingInvite(code: string | null) {
  const normalized = normalizeInviteCode(code);
  memoryPending = normalized;
  const s = safeStorage();
  if (!s) return;
  if (normalized) s.setItem(PENDING_KEY, normalized);
  else s.removeItem(PENDING_KEY);
}

export function clearPendingInvite() {
  setPendingInvite(null);
}

/** Parse a hash location like "/join/3S3662" → "3S3662". */
export function inviteCodeFromPath(path: string): string | null {
  const m = /^\/join\/([^/?#]+)/i.exec(path);
  return m ? normalizeInviteCode(decodeURIComponent(m[1])) : null;
}

/** Full, shareable deep link: <origin><pathname>#/join/<code>. Never hardcode the host. */
export function inviteUrl(code: string): string {
  const base = `${window.location.origin}${window.location.pathname}`.replace(/\/+$/, "");
  return `${base}/#/join/${encodeURIComponent(code)}`;
}

export function inviteShareText(crewName: string, code: string): string {
  return `Join my crew "${crewName}" on MMV: ${inviteUrl(code)}  — open it in Safari, tap Share → Add to Home Screen, then sign up (first name, handle, 4-digit PIN). Code: ${code}`;
}

export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

/** Native share sheet when available, otherwise clipboard. */
export async function shareInvite(crewName: string, code: string): Promise<ShareOutcome> {
  const text = inviteShareText(crewName, code);
  const url = inviteUrl(code);
  const title = `Join "${crewName}" on MMV`;
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ title, text, url });
      return "shared";
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") return "cancelled";
      // fall through to clipboard
    }
  }
  return (await copyText(text)) ? "copied" : "failed";
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** True when running as an installed home-screen app (iOS or Android). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch {
    /* ignore */
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

// ---------- Shop for ----------
// Mirrors shared/schema SHOP_FOR; kept as a local const so the client still builds if the shared
// export is renamed, but typed against the shared ShopFor so they can't drift silently.
import type { ShopFor } from "@shared/schema";
export type { ShopFor };
export const SHOP_FOR_VALUES: readonly ShopFor[] = ["womens", "mens", "unisex"];
export const SHOP_FOR_OPTIONS: { value: ShopFor; label: string }[] = [
  { value: "womens", label: "Women's" },
  { value: "mens", label: "Men's" },
  { value: "unisex", label: "Either" },
];

export function isShopFor(v: unknown): v is ShopFor {
  return typeof v === "string" && (SHOP_FOR_VALUES as readonly string[]).includes(v);
}
