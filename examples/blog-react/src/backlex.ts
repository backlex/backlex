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
// ── Multi-language ───────────────────────────────────────────────────────────
// The blog is bilingual. `title` and `body` are **localized** fields: each one
// stores a per-locale map `{ en: "...", tr: "..." }`. On *read* you pass
// `list({ locale })` / `search({ locale })` and the API collapses every
// localized field down to that locale's string (with a fallback chain). On
// *write* you send the map. Add the languages in the admin (Settings →
// Languages); see the README.
export const LOCALES = ["en", "tr"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_LABEL: Record<Locale, string> = { en: "English", tr: "Türkçe" };

/** A per-locale value, e.g. `{ en: "Hello", tr: "Merhaba" }`. */
export type I18nText = Partial<Record<Locale, string>>;

// Matches the `posts` collection you create in the admin UI (see README).
// `posts` is **versioned** (draft/publish on). Versioning manages the lifecycle
// columns itself and exposes them with a leading underscore: `_status`
// (`draft` | `published`) and `_published_at`. You never *write* these — new
// rows are drafts; `publish()` / `unpublish()` flip them.
//
// `title` / `body` are typed as `string` here because the app always reads with
// a `locale`, so they arrive collapsed. (Read with `locale: "*"` to get the raw
// `{ en, tr }` map instead.) The `& Record<…>` satisfies the SDK's row-type
// constraint; `backlex gen-types --sdk` can generate these for you.
export type Post = {
  id: string;
  title: string;
  slug?: string;
  excerpt?: string;
  body?: string;
  _status?: "draft" | "published";
  _published_at?: string | null;
  created_at?: string;
} & Record<string, unknown>;

/** Shape of a create/update payload — the localized fields take a locale map. */
export type PostWrite = {
  title: I18nText;
  body?: I18nText;
  slug?: string;
  excerpt?: string;
};

/** The typed CRUD handle for the `posts` collection. */
export const posts = backlex.from<Post>("posts");
