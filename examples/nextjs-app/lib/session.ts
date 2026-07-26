import "server-only";
import { cookies } from "next/headers";

/**
 * Where the workspace session token lives.
 *
 * The Vite examples in this repo stash it in `localStorage`, which is fine for a
 * client-rendered SPA and useless for server rendering: a Server Component runs
 * before any browser JavaScript, so it can't read `localStorage` — it can only
 * read what the browser *sent*, i.e. cookies.
 *
 * `httpOnly` means the token isn't reachable from page scripts at all, which
 * closes the XSS-exfiltration path `localStorage` leaves open. The trade-off is
 * that a browser-side backlex client can no longer authenticate — hence this app
 * doing every call on the server.
 */
const COOKIE = process.env.BACKLEX_SESSION_COOKIE || "backlex_session";

/** One month — matches the default session lifetime on the backend. */
const MAX_AGE = 60 * 60 * 24 * 30;

export async function readSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(COOKIE)?.value;
}

export async function writeSessionToken(token: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Plain HTTP in local dev; the browser rejects a `secure` cookie there.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function clearSessionToken(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}
