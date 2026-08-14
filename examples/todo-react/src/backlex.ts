import { createClient } from "backlex";
import { API_URL, WORKSPACE } from "@backlex-examples/shared";

// ── Config (from .env — see .env.example, validated by <SetupCheck>) ─────────
// Empty `url` = same-origin: the SDK issues relative `/api/...` requests that
// the Vite dev proxy (vite.config.ts) forwards to the backend. Set
// VITE_BACKLEX_URL to your deployed API origin for a cross-origin production
// build. A missing workspace is surfaced by the in-app setup check rather than
// crashing here, so the user sees what to fix.
//
// `persist: true` is the whole session story. The SDK captures the workspace
// session token from sign-in and writes it through to `localStorage` on the one
// path every capture goes through — so a reload stays signed in, and signing
// out clears it, without this file owning a token helper that each screen has
// to remember to call.
export const backlex = createClient({
  url: API_URL,
  workspace: WORKSPACE,
  persist: true,
});

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
