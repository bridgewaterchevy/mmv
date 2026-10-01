// Token store that survives reloads when storage is available (installed PWA / normal tab)
// and degrades to memory inside sandboxed iframes where storage access throws.
let memoryToken: string | null = null;
const KEY = "mmv.token";

function safeStorage(): Storage | null {
  try {
    const s = window.localStorage;
    s.getItem(KEY);
    return s;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  const s = safeStorage();
  memoryToken = s?.getItem(KEY) ?? null;
  return memoryToken;
}

export function setToken(token: string | null) {
  memoryToken = token;
  const s = safeStorage();
  if (!s) return;
  if (token) s.setItem(KEY, token);
  else s.removeItem(KEY);
}
