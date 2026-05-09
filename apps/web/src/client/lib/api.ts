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
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
};
