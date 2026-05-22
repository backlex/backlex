# Admin SPA translation (Lingui)

The admin SPA's own UI strings — the "admin chrome": nav, buttons, page
titles, dialogs, toasts, form labels — are translatable via
[Lingui](https://lingui.dev) 6. This is **separate** from the workspace
content-translation system (`i18n_strings` table, the Translations page),
which translates *content* the admin authors. See `docs/locale-timezone.md`
for that distinction.

## How it works

Strings in `apps/web/src/client` are wrapped in Lingui macros:

```tsx
import { Trans } from "@lingui/react/macro";
import { useLingui } from "@lingui/react/macro";

<Button><Trans>Save</Trans></Button>;          // JSX text
const { t } = useLingui();
<input placeholder={t`Search`} />;              // attributes / dynamic strings
pushToast(t`Collection ${slug} created.`);      // template literals
```

The macros are transformed at build time by `@lingui/babel-plugin-lingui-macro`
(wired into `@vitejs/plugin-react`'s Babel pass in `vite.config.ts`), so there
is **no runtime macro cost**. `@lingui/vite-plugin` compiles `.po` catalogs to
message objects.

- **English** is the source locale. The English text lives inline in the
  components — the macro keeps it as the runtime fallback, so `en` needs no
  catalog and any untranslated string in another locale degrades to English.
- **Other locales** are compiled into the bundle from their `.po` file
  (`src/client/locales/<locale>/messages.po`) and loaded as a lazy chunk on
  first activation.

### Runtime

`apps/web/src/client/admin/i18n.ts` owns the runtime:

- `i18n` — the `@lingui/core` instance, wrapped by `<I18nProvider>` in
  `App.tsx`.
- `activateAdminLocale(tag)` — resolves a BCP-47 tag to a shipped admin
  locale (`ADMIN_LOCALES`), lazy-loads its `.po`, and activates it.
- `AdminLocaleSync` — mounted inside `PreferencesProvider`; re-activates the
  Lingui locale whenever the signed-in user's resolved language preference
  changes. So the admin language follows the **same** preference that already
  drives date/number formatting — there is no separate language switch. It
  stays idle while `PreferencesProvider` is still `loading`: until the
  `/api/account/preferences` call resolves, `usePreferences().locale` reports
  the `DEFAULT_LOCALE` (`en`) fallback, and activating that would flip the
  boot locale to English and back. The boot locale set by `bootAdminLocale`
  stays active until the resolved preference is actually known.

An unsupported tag (e.g. `pt-BR` when only `en`/`tr` ship) falls back to
English.

> **Caveat — JSX-less files.** `@vitejs/plugin-react` only runs Babel on files
> that contain JSX, so Lingui macros are **not** transformed in plain `.ts`
> files or JSX-less modules. Keep `msg` / `Trans` / `t` in `.tsx` files that
> render JSX. Module-scope label maps (e.g. the sidebar nav labels) live in
> `admin/ui.tsx::navLabel`, not in `admin/config.ts`.

## Working with translations

```bash
bun run --cwd apps/web i18n:extract   # scan src/client, update every .po
```

`lingui extract` adds new message ids to every locale's `.po` (with an empty
`msgstr`) and drops removed ones. Run it after adding or changing UI strings.

To translate a locale, fill the `msgstr` entries in its `.po`. Placeholders
must be preserved exactly:

- `{name}`, `{0}` — interpolated values.
- `<0>…</0>`, `<1/>` — nested JSX elements (translate the text, keep the tags).

## Adding a language

1. Add the BCP-47 code to `locales` in `apps/web/lingui.config.ts`.
2. Add it to `ADMIN_LOCALES` and `CATALOG_LOADERS` in `admin/i18n.ts`.
3. Run `bun run --cwd apps/web i18n:extract` to generate the catalog.
4. Translate `src/client/locales/<code>/messages.po`.

The language then appears wherever the workspace language list is offered
(Settings → General, Account → Preferences), and the admin renders in it for
any member whose resolved locale matches.
