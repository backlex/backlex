// Lingui runtime for the admin SPA ("admin chrome" translation).
//
// English source strings live inline in the components — the Lingui macro
// keeps them as the runtime fallback, so `en` needs no catalog. Every other
// locale is compiled into the bundle from its `.po` file and loaded as a
// lazy chunk on demand.
//
// The active locale is driven by the signed-in user's resolved language
// preference — see `AdminLocaleSync`, mounted inside `PreferencesProvider`.
import { useEffect } from "react";
import { i18n } from "@lingui/core";
import { usePreferences } from "./preferences";

/** Locales the admin chrome ships translations for. Adding one is: a new
 *  `locales/<code>/messages.po`, an entry here, and a `CATALOG_LOADERS` row. */
export const ADMIN_LOCALES = ["en", "tr"] as const;
export type AdminLocale = (typeof ADMIN_LOCALES)[number];

export const DEFAULT_ADMIN_LOCALE: AdminLocale = "en";

/** Lazy `.po` loaders per non-source locale. `en` is intentionally absent —
 *  English renders straight from the inline source messages. Catalogs live
 *  in `src/client/locales` (see `lingui.config.ts`), one level up. */
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

// Activate `en` synchronously at module load so `<I18nProvider>` always has
// an active locale before first paint (Lingui throws otherwise). English
// renders from the inline source messages — no catalog needed.
i18n.load(DEFAULT_ADMIN_LOCALE, {});
i18n.activate(DEFAULT_ADMIN_LOCALE);

const loaded = new Set<string>([DEFAULT_ADMIN_LOCALE]);

/** Load (once) and activate `tag`'s admin locale. Pulls the compiled `.po`
 *  catalog as a lazy chunk. Safe to call repeatedly; a failed chunk load
 *  degrades to the English source. */
export async function activateAdminLocale(
  tag: string | null | undefined,
): Promise<void> {
  const locale = resolveAdminLocale(tag);
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

/** Side-effect-only component: keeps the active Lingui locale in sync with
 *  the signed-in user's resolved language preference. Renders nothing —
 *  mount it inside `PreferencesProvider`. */
export function AdminLocaleSync(): null {
  const { locale } = usePreferences();
  useEffect(() => {
    void activateAdminLocale(locale);
  }, [locale]);
  return null;
}

export { i18n };
