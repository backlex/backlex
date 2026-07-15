import { createClient } from "backlex";
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
