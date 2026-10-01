import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { getToken } from "./token";
import { recordApiError } from "./errorlog";

export const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export function assetUrl(path: string) {
  // Absolute URLs (e.g. Supabase Storage public objects) pass through untouched.
  if (/^(https?:)?\/\//i.test(path) || path.startsWith("data:") || path.startsWith("blob:")) return path;
  return `${API_BASE}${path}`;
}

/** Error thrown for non-2xx responses; `status` lets callers special-case e.g. 429 without parsing text. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** HTTP status of a caught error, or undefined for network/unknown failures. */
export function errorStatus(e: unknown): number | undefined {
  return e instanceof ApiError ? e.status : undefined;
}

async function throwIfResNotOk(res: Response, method = "GET") {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.message ?? message;
    } catch {
      /* ignore */
    }
    const text = message || `${res.status}`;
    recordApiError(method, res.url || "", text, res.status);
    throw new ApiError(text, res.status);
  }
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { "x-auth-token": t } : {};
}

export async function apiRequest(method: string, url: string, data?: unknown): Promise<Response> {
  const isForm = typeof FormData !== "undefined" && data instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${url}`, {
      method,
      headers: { ...authHeaders(), ...(data && !isForm ? { "Content-Type": "application/json" } : {}) },
      body: isForm ? (data as FormData) : data ? JSON.stringify(data) : undefined,
    });
  } catch (e) {
    // Offline / DNS / CORS — the server never answered.
    recordApiError(method, `${API_BASE}${url}`, e instanceof Error ? e.message : String(e));
    throw e;
  }
  await throwIfResNotOk(res, method);
  return res;
}

export async function apiJson<T>(method: string, url: string, data?: unknown): Promise<T> {
  const res = await apiRequest(method, url, data);
  return (await res.json()) as T;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: { on401: UnauthorizedBehavior }) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, { headers: authHeaders() });
    if (unauthorizedBehavior === "returnNull" && res.status === 401) return null;
    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: true,
      staleTime: 15_000,
      retry: false,
    },
    mutations: { retry: false },
  },
});
