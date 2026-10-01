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

/**
 * Multipart upload with byte-level progress (fetch has no upload progress, so this uses XHR).
 * Resolves with the parsed JSON body; rejects with ApiError on non-2xx like apiRequest does.
 */
export function apiUpload<T>(url: string, data: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const full = `${API_BASE}${url}`;
    xhr.open("POST", full);
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.responseType = "text";
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
      };
    }
    xhr.onerror = () => {
      recordApiError("POST", full, "Network error");
      reject(new Error("Couldn't reach the server. Check your connection and try again."));
    };
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        /* non-JSON body */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve(body as T);
        return;
      }
      const message = (body as { message?: string } | null)?.message || xhr.statusText || `${xhr.status}`;
      recordApiError("POST", full, message, xhr.status);
      reject(new ApiError(message, xhr.status));
    };
    xhr.send(data);
  });
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
