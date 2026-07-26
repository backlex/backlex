import { BacklexError, createClient } from "backlex";

/**
 * The admin-plane backlex client.
 *
 * The `.server.ts` suffix is a React Router convention: the compiler refuses to
 * include this module in a browser bundle, so importing it from a component by
 * accident is a build error rather than a leaked key. Every namespace reached
 * from here (`jobs`, `flows`, `agents`, `permissions`, `usage`, …) is guarded by
 * `requireAdmin` server-side — a workspace end-user session gets a 403, which is
 * why the browser examples have no panels for them.
 *
 * Built lazily so a missing `BACKLEX_API_KEY` surfaces as an in-app setup screen
 * (see `app/routes/_index.tsx`) instead of crashing the server at import time.
 */
let cached: ReturnType<typeof createClient> | null = null;

export function adminClient() {
  if (!cached) {
    cached = createClient({
      url: process.env.BACKLEX_URL || "http://localhost:5173",
      apiKey: process.env.BACKLEX_API_KEY,
      ...(process.env.BACKLEX_TENANT ? { tenant: process.env.BACKLEX_TENANT } : {}),
    });
  }
  return cached;
}

/** Whether the server has enough config to talk to the admin plane at all. */
export const isConfigured = (): boolean => Boolean(process.env.BACKLEX_API_KEY);

/**
 * Run an admin call and turn a failure into a value instead of a thrown
 * response. Every route renders its own error inline, so one unreachable
 * capability (no AI provider configured, jobs disabled, …) degrades that
 * section rather than the page.
 */
export async function attempt<T>(fn: () => Promise<T>): Promise<
  { ok: true; data: T } | { ok: false; error: string }
> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof BacklexError) {
    // A 401/403 here almost always means the key is missing or not an admin
    // key — say so, since that's the single most common setup mistake.
    if (err.status === 401 || err.status === 403) {
      return `${err.message} — is BACKLEX_API_KEY an admin key for this workspace?`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
