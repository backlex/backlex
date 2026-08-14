import { createClient } from "backlex";
import { API_URL, WORKSPACE } from "@backlex-examples/shared";

// ── Config (from .env — see .env.example, validated by SetupCheck.tsx) ───────
// Empty `url` = same-origin: the SDK issues relative `/api/...` requests that
// the Vite dev proxy (vite.config.ts) forwards to the backend. Set
// VITE_BACKLEX_URL to your deployed API origin for a cross-origin production
// build. A missing workspace is surfaced by the in-app setup check rather than
// crashing here, so the user sees what to fix.
const url = API_URL;
const workspace = WORKSPACE;

// `persist: true` is the whole session story: the SDK writes the captured
// token through on the ONE path every capture goes through, so a reload stays
// signed in and signing out clears it — with no token helper for each screen
// to remember to call.
export const backlex = createClient({
  url,
  workspace,
  persist: true,
});

// ── Collection row type ─────────────────────────────────────────────────────
// The showcase deliberately drives EVERY panel off a single `notes` collection
// you create in the admin UI (see README) — one collection keeps admin setup to
// a minimum while still exercising CRUD, the query builder, aggregates, search,
// realtime, draft/publish, storage, offline sync, and feature flags. Enable the
// optional capabilities (versioning for draft/publish, full-text search for the
// search panel) when you want those panels to light up; the app degrades
// gracefully if they're off.
//
// The `& Record<string, unknown>` satisfies the SDK's row-type constraint;
// `backlex gen-types --sdk` can generate these for you in a real project.
export type Note = {
  id: string;
  title: string;
  body?: string;
  // Versioning manages the lifecycle column and exposes it as `_status`
  // (`draft` | `published`). You never write it — new rows are drafts and
  // `publish()` / `unpublish()` flip it.
  _status?: "draft" | "published";
  priority?: number;
  done?: boolean;
  created_at?: string;
} & Record<string, unknown>;

/** The typed CRUD handle for the `notes` collection — every panel uses this. */
export const notes = backlex.from<Note>("notes");
