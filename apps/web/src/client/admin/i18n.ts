// Lingui runtime for the admin SPA ("admin chrome" translation).
//
// The Lingui macro compiles `<Trans>` to a hashed message id; the readable
// text lives only in the compiled catalogs. So `en` needs its catalog too —
// it is imported eagerly (it is the default + fallback locale and must be
// ready before first paint). Every other locale is compiled from its `.po`
// and loaded as a lazy chunk on demand.
//
// The active locale is driven by the signed-in user's resolved language
// preference — see `AdminLocaleSync`, mounted inside `PreferencesProvider`.
import { useEffect } from "react";
import { i18n } from "@lingui/core";
import { messages as enMessages } from "../locales/en/messages.po";
import { usePreferences } from "./preferences";

/** Locales the admin chrome ships translations for. Adding one is: a new
 *  `locales/<code>/messages.po`, an entry here, and a `CATALOG_LOADERS` row. */
export const ADMIN_LOCALES = ["en", "tr"] as const;
export type AdminLocale = (typeof ADMIN_LOCALES)[number];

export const DEFAULT_ADMIN_LOCALE: AdminLocale = "en";

/** localStorage key for the last active locale — lets the next boot paint
 *  the right language before the preferences API responds. */
const LOCALE_STORAGE_KEY = "backlex.adminLocale";

function persistLocale(locale: string): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // storage unavailable (private mode etc.) — non-fatal
  }
}

/** Lazy `.po` loaders per non-default locale. `en` is absent — its catalog
 *  is imported eagerly above. Catalogs live in `src/client/locales`. */
const CATALOG_LOADERS: Record<
  string,
  () => Promise<{ messages: Record<string, string> }>
> = {
  tr: () => import("../locales/tr/messages.po"),
};

/** Narrow an arbitrary BCP-47 tag to a shipped admin locale. `pt-BR` and any
 *  other unsupported tag fall back to English. */
export function resolveAdminLocale(
  tag: string | null | undefined,
): AdminLocale {
  if (!tag) return DEFAULT_ADMIN_LOCALE;
  const lower = tag.toLowerCase();
  for (const locale of ADMIN_LOCALES) {
    if (lower === locale || lower.startsWith(`${locale}-`)) return locale;
  }
  return DEFAULT_ADMIN_LOCALE;
}

// Load + activate `en` synchronously at module load so `<I18nProvider>` has
// an active locale with real text before first paint.
i18n.load(DEFAULT_ADMIN_LOCALE, enMessages);
i18n.activate(DEFAULT_ADMIN_LOCALE);

const loaded = new Set<string>([DEFAULT_ADMIN_LOCALE]);

/** Load (once) and activate `tag`'s admin locale. Pulls the compiled `.po`
 *  catalog as a lazy chunk. Safe to call repeatedly; a failed chunk load
 *  degrades to the English source. */
export async function activateAdminLocale(
  tag: string | null | undefined,
): Promise<void> {
  const locale = resolveAdminLocale(tag);
  persistLocale(locale);
  if (locale === DEFAULT_ADMIN_LOCALE) {
    i18n.activate(locale);
    return;
  }
  if (!loaded.has(locale)) {
    let messages: Record<string, string> = {};
    const loader = CATALOG_LOADERS[locale];
    if (loader) {
      try {
        messages = (await loader()).messages ?? {};
      } catch {
        // catalog chunk failed to load — fall through to the English source
      }
    }
    i18n.load(locale, messages);
    loaded.add(locale);
  }
  i18n.activate(locale);
}

/** Resolve + activate the boot locale before first paint: the locale
 *  persisted from a previous session, else the browser language. Awaited in
 *  `main.tsx` so the sign-in screen and first render are already translated
 *  (no English flash). `AdminLocaleSync` refines it once the user is known. */
export async function bootAdminLocale(): Promise<void> {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // storage unavailable — fall back to the browser language
  }
  await activateAdminLocale(stored ?? navigator.language);
}

/** Side-effect-only component: keeps the active Lingui locale in sync with
 *  the signed-in user's resolved language preference. Renders nothing —
 *  mount it inside `PreferencesProvider`.
 *
 *  Gated on `loading`: until the preferences API resolves, `usePreferences`
 *  reports the `DEFAULT_LOCALE` ("en") fallback rather than the user's real
 *  locale. Activating that fallback would flip the chrome to English and
 *  straight back — the exact flash `bootAdminLocale` already paints around.
 *  So we wait: the boot locale stays active until the resolved preference is
 *  actually known, then we activate it once. */
export function AdminLocaleSync(): null {
  const { locale, loading } = usePreferences();
  useEffect(() => {
    if (loading) return;
    void activateAdminLocale(locale);
  }, [locale, loading]);
  return null;
}

export { i18n };
