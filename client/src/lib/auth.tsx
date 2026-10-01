import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { PublicUser } from "@shared/schema";
import { apiJson, queryClient } from "./queryClient";
import { getToken, setToken } from "./token";

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  signup: (data: { name: string; handle: string; pin: string }) => Promise<void>;
  login: (data: { handle: string; pin: string }) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = getToken();
    if (!t) {
      setLoading(false);
      return;
    }
    apiJson<PublicUser>("GET", "/api/me")
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const handleAuth = useCallback((res: { token: string; user: PublicUser }) => {
    setToken(res.token);
    setUser(res.user);
    queryClient.clear();
    if (window.location.hash && window.location.hash !== "#/") window.location.hash = "#/";
  }, []);

  const signup = useCallback(
    async (data: { name: string; handle: string; pin: string }) => handleAuth(await apiJson("POST", "/api/auth/signup", data)),
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

  const value = useMemo(() => ({ user, loading, signup, login, logout }), [user, loading, signup, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}
