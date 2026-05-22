import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

/**
 * Lingui config — translation of the admin SPA's own UI strings
 * ("admin chrome"), separate from the workspace `i18n_strings` content
 * translation system surfaced on the Translations page.
 *
 * Scope is `src/client` only: the React admin app. The Hono server
 * (`src/server`) is never scanned — it has no user-facing UI strings.
 *
 * `en` is the source locale. English text lives inline in the components
 * (the macro keeps it as the runtime fallback), so the `en` catalog is only
 * a translator artifact. Every other locale is compiled into the bundle
 * from its `.po` file. Run `bun run i18n:extract` after adding strings.
 */
export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "tr"],
  catalogs: [
    {
      path: "<rootDir>/src/client/locales/{locale}/messages",
      include: ["<rootDir>/src/client"],
    },
  ],
  // `lineNumbers: false` keeps the `.po` diff stable when code moves around.
  format: formatter({ lineNumbers: false }),
});
