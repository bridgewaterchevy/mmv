import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { PublicUser } from "@shared/schema";
import { apiJson, queryClient } from "./queryClient";
import { getToken, setToken } from "./token";
import { getPendingInvite, isShopFor, type ShopFor } from "./invite";

/** Auth user as the client sees it. `shopFor` is optional so older servers still type-check. */
export type AppUser = PublicUser & { shopFor?: ShopFor | null };

interface AuthState {
  user: AppUser | null;
  loading: boolean;
  signup: (data: { name: string; handle: string; pin: string; shopFor?: ShopFor }) => Promise<void>;
  login: (data: { handle: string; pin: string }) => Promise<void>;
  logout: () => void;
  /** PATCH /api/me { shopFor } and update the cached user. Resolves false if the server rejected it. */
  setShopFor: (shopFor: ShopFor | null) => Promise<boolean>;
}

const AuthContext = createContext<AuthState | null>(null);

function normalizeUser(u: AppUser): AppUser {
  const raw = (u as { shopFor?: unknown }).shopFor;
  return { ...u, shopFor: isShopFor(raw) ? raw : null };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = getToken();
    if (!t) {
      setLoading(false);
      return;
    }
    apiJson<AppUser>("GET", "/api/me")
      .then((u) => setUser(normalizeUser(u)))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const handleAuth = useCallback((res: { token: string; user: AppUser }) => {
    setToken(res.token);
    setUser(normalizeUser(res.user));
    queryClient.clear();
    // A pending invite is picked up by <InviteGate /> once the signed-in tree mounts; otherwise land on Crews.
    if (!getPendingInvite() && window.location.hash && window.location.hash !== "#/") window.location.hash = "#/";
  }, []);

  const signup = useCallback(
    async (data: { name: string; handle: string; pin: string; shopFor?: ShopFor }) => {
      const body: Record<string, string> = { name: data.name, handle: data.handle, pin: data.pin };
      if (data.shopFor) body.shopFor = data.shopFor;
      handleAuth(await apiJson("POST", "/api/auth/signup", body));
    },
    [handleAuth],
  );
  const login = useCallback(
    async (data: { handle: string; pin: string }) => handleAuth(await apiJson("POST", "/api/auth/login", data)),
    [handleAuth],
  );
  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    queryClient.clear();
  }, []);

  const setShopFor = useCallback(async (shopFor: ShopFor | null) => {
    // Optimistic: the preference is cosmetic, so update immediately and quietly roll back on failure.
    let previous: ShopFor | null | undefined;
    setUser((u) => {
      previous = u?.shopFor;
      return u ? { ...u, shopFor } : u;
    });
    try {
      const updated = await apiJson<AppUser>("PATCH", "/api/me", { shopFor });
      if (updated && typeof updated === "object" && "id" in updated) setUser((u) => (u ? normalizeUser({ ...u, ...updated, shopFor }) : u));
      return true;
    } catch {
      setUser((u) => (u ? { ...u, shopFor: previous ?? null } : u));
      return false;
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, signup, login, logout, setShopFor }),
    [user, loading, signup, login, logout, setShopFor],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}
