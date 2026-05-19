const base = import.meta.env.VITE_API_URL ?? "";

/**
 * Latest D1 Sessions-API bookmark seen on a response. We round-trip it on
 * subsequent requests as the `x-d1-bookmark` header so a write made in one
 * request is guaranteed visible to the reads in the next (read-your-writes
 * across requests). The string is opaque — we just shuttle it back and forth.
 */
let d1Bookmark: string | null = null;

export interface ApiErrorDetail {
  path?: (string | number)[];
  message?: string;
  code?: string;
}

/**
 * Thrown by api() on any non-2xx. Inherits Error so call sites that only
 * read `.message` keep working; new code can read `.code`/`.details`/`.status`
 * to render per-field hints (e.g. inline against a form input).
 */
export class ApiError extends Error {
  status: number;
  code?: string;
  details?: ApiErrorDetail[];
  constructor(message: string, status: number, code?: string, details?: ApiErrorDetail[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${base}${path}`, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(d1Bookmark ? { "x-d1-bookmark": d1Bookmark } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  // Capture the latest bookmark so the next request can pin its session
  // forward. Header is exposed via CORS in app.ts so reading it here works
  // for cross-origin deploys too.
  const bm = res.headers.get("x-d1-bookmark");
  if (bm) d1Bookmark = bm;
  if (!res.ok) {
    // Mid-session 401: tell the AuthGate to bounce to /sign-in. Skip when
    // we're already on the auth pages (probing get-session there is normal).
    if (res.status === 401 && typeof window !== "undefined") {
      const onAuthPage = /^\/sign-(in|up)/.test(window.location.pathname);
      if (!onAuthPage) {
        window.dispatchEvent(new Event("workeros:session-expired"));
      }
    }
    // Two error response shapes flow through here:
    //   1) `{error: {code, message, details?}}` — framework default from AppError
    //   2) `{ok: false, error: "...", logs: […]}` — the sandbox/function
    //      invoker returns its raw SandboxResult on 500 so callers can
    //      surface logs alongside the failure.
    // For the second shape, throw the JSON-encoded body so callers can
    // re-parse it and pull out logs/error/durationMs.
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; code?: string; details?: ApiErrorDetail[] } | string;
    };
    if (body && typeof body.error === "object" && body.error?.message) {
      throw new ApiError(body.error.message, res.status, body.error.code, body.error.details);
    }
    if (body && Object.keys(body).length > 0) {
      throw new ApiError(JSON.stringify(body), res.status);
    }
    throw new ApiError(`HTTP ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
};
