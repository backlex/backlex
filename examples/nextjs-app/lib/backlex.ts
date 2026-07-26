import "server-only";
import { BacklexError, createClient } from "backlex";
import { readSessionToken } from "./session";

const API_URL = process.env.BACKLEX_URL || "http://localhost:5173";

/**
 * A `fetch` that stamps an `Origin` header on every call.
 *
 * Browsers set `Origin` automatically; a server does not. better-auth enforces
 * a CSRF origin check on writes and answers a header-less request with **403**,
 * so *every* server-side auth call fails without this — the failure mode that
 * makes server-rendered auth look impossible.
 *
 * Sending the API's own origin is the local-dev shortcut (it is trusted by
 * definition). In production, point this at your app's real origin and register
 * it on the backend via `EXTRA_TRUSTED_ORIGINS` or the workspace's auth
 * redirect URLs.
 */
// The cast is deliberate: in a Next app `typeof fetch` carries React's
// `preconnect` extension, which a plain wrapper doesn't implement and the SDK
// never calls.
const fetchWithOrigin = ((input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  headers.set("origin", API_URL);
  return fetch(input, { ...init, headers });
}) as typeof fetch;

/**
 * A backlex client for the *current request*.
 *
 * Deliberately not a module-level singleton: on a server, one client per module
 * would be shared across concurrent requests from different users, and the
 * session token is per-user state. Building it per call keeps requests isolated
 * — the cost is an object allocation, not a connection.
 *
 * `workspace` puts the SDK in app mode, so this authenticates as a **workspace
 * end-user** (the consumer plane), not an admin. For the admin half — jobs,
 * flows, agents, permissions — see `examples/react-router-app`.
 */
export async function backlexForRequest() {
  return createClient({
    url: API_URL,
    workspace: WORKSPACE,
    token: await readSessionToken(),
    fetch: fetchWithOrigin,
  });
}

/** An unauthenticated client — used by sign-in/sign-up, before a token exists. */
export function anonymousClient() {
  return createClient({
    url: API_URL,
    workspace: WORKSPACE,
    fetch: fetchWithOrigin,
  });
}

export const WORKSPACE = process.env.BACKLEX_WORKSPACE || "";

/** Whether the server has enough config to talk to a workspace at all. */
export const isConfigured = (): boolean => Boolean(WORKSPACE);

export function errorMessage(err: unknown): string {
  if (err instanceof BacklexError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** The `notes` collection this example reads and writes. */
export type Note = {
  id: string;
  title: string;
  done: boolean;
  created_at?: string;
} & Record<string, unknown>;
