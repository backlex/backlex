import "server-only";
import { BacklexError, createClient } from "backlex";
import { readSessionToken } from "./session";

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
    url: process.env.BACKLEX_URL || "http://localhost:5173",
    workspace: WORKSPACE,
    token: await readSessionToken(),
  });
}

/** An unauthenticated client — used by sign-in/sign-up, before a token exists. */
export function anonymousClient() {
  return createClient({
    url: process.env.BACKLEX_URL || "http://localhost:5173",
    workspace: WORKSPACE,
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
