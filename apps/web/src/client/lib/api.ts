const base = import.meta.env.VITE_API_URL ?? "";

export const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${base}${path}`, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
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
    //   1) `{error: {code, message}}` — the framework default from AppError
    //   2) `{ok: false, error: "...", logs: […]}` — the sandbox/function
    //      invoker returns its raw SandboxResult on 500 so callers can
    //      surface logs alongside the failure.
    // For the second shape, throw the JSON-encoded body so callers can
    // re-parse it and pull out logs/error/durationMs.
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string } | string;
    };
    const fwError = typeof body.error === "object" ? body.error?.message : undefined;
    if (fwError) {
      throw new Error(fwError);
    }
    if (Object.keys(body).length > 0) {
      throw new Error(JSON.stringify(body));
    }
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
};
