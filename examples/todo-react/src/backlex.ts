import { createClient } from "@backlex/client";
import { API_URL, WORKSPACE } from "./env";

// ── Config (from .env — see .env.example, validated by SetupCheck.tsx) ───────
// Empty `url` = same-origin: the SDK issues relative `/api/...` requests that
// the Vite dev proxy (vite.config.ts) forwards to the backend. Set
// VITE_BACKLEX_URL to your deployed API origin for a cross-origin production
// build. A missing workspace is surfaced by the in-app setup check rather than
// crashing here, so the user sees what to fix.
const url = API_URL;
const workspace = WORKSPACE;

// ── Session-token persistence ───────────────────────────────────────────────
// In "app mode" (a `workspace` is set) the SDK captures the workspace session
// token returned by signIn/signUp and replays it as a bearer on every request.
// We stash it in localStorage so a page reload stays signed in, and hand it
// back to `createClient({ token })` on boot.
const TOKEN_KEY = `backlex.token.${workspace}`;

export const backlex = createClient({
  url,
  workspace,
  token: localStorage.getItem(TOKEN_KEY) ?? undefined,
});

/** Mirror the SDK's current token into localStorage (call after sign-in/out). */
export function persistToken(): void {
  const token = backlex.auth.getToken();
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// ── Collection row type ─────────────────────────────────────────────────────
// Matches the `todos` collection you create in the admin UI (see README).
// The `& Record<string, unknown>` satisfies the SDK's row-type constraint;
// `backlex gen-types --sdk` can generate these for you in a real project.
export type Todo = {
  id: string;
  title: string;
  done: boolean;
  created_at?: string;
} & Record<string, unknown>;

/** The typed CRUD handle for the `todos` collection. */
export const todos = backlex.from<Todo>("todos");
