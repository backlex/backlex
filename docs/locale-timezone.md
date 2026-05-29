---
title: Language & time zone
description: How locale and IANA time zone resolve from per-user override to workspace default.
---

backlex resolves a **locale** and an **IANA time zone** for every signed-in
admin and uses them to format dates, times and numbers across the admin SPA.
Both are layered: a personal override falls through to a workspace default,
which falls through to a built-in fallback.

```
effective locale   = users.locale      ?? app_settings.i18nDefaultLocale ?? "en"
effective timezone = users.timezone    ?? app_settings.timezone          ?? "UTC"
```

## Workspace settings

**Settings → General → workspace languages card.** Admin-only. Persisted to the
`app_settings` key/value table via `PATCH /api/admin/settings` (the same
whitelist the rest of the General tab uses).

- **Languages** (`i18nLocales`) — the languages this workspace is translated
  into. They are the columns of the **Translations** page and the locale
  options a member can choose in their account. The list is managed
  dynamically: pick from the common-languages list or type any BCP-47 code
  (e.g. `pt-BR`, `zh-Hant`). At least one language is always required.
- **Default language** (`i18nDefaultLocale`) — applied to members who haven't
  picked one. Must be a member of `i18nLocales` (the API rejects a default
  that isn't in the list).
- **Default time zone** (`timezone`) — an IANA zone applied to members who
  haven't set a personal one. Validated against `Intl` server-side.

Adding or removing a language here immediately changes the Translations grid
and the locale picker in every member's **Account → Preferences** tab.

## Per-user preferences

**Account → Preferences tab.** Every signed-in user (admin or not) can set
their own language and time zone, or leave either on "Workspace default".

- Stored as `users.locale` / `users.timezone` (both nullable — `NULL` means
  "inherit").
- Endpoints: `GET /api/account/preferences` returns the raw user values, the
  workspace defaults, and the resolved `effective` values; `PATCH` with
  `{ locale?, timezone? }` updates them. Pass `null` (or `""`) to clear a
  field back to the workspace default; omit it to leave it unchanged.

## Using it in the admin SPA

`PreferencesProvider` (mounted around the whole admin app) loads the resolved
preferences once. Any component reads them through `usePreferences()`:

```tsx
const { locale, timezone, formatDate, formatDateTime, formatRelative } =
  usePreferences();

formatDateTime(row.createdAt); // rendered in the user's zone + locale
```

The formatters are `Intl`-backed and degrade to `en` / `UTC` if a stored
locale or zone is somehow invalid. `timezoneOptions()` and `languageOptions()`
(in `client/admin/preferences.tsx`) build the picker option lists shared by the
Settings and Account forms.

## Scope

The locale has three jobs:

1. **Date/number formatting** — the `Intl`-backed formatters above.
2. **Admin SPA chrome** — the admin's own UI strings (nav, buttons, dialogs,
   toasts) are translated via Lingui; the effective locale picks the catalog.
   See `docs/admin-i18n.md`.
3. **Workspace content** — it is the default locale for the workspace i18n
   string resolution (`/api/i18n`). The `i18n_strings` table and the
   Translations page are the surface for translating *content* the admin
   authors; its locale columns are exactly the `i18nLocales` list above.

Jobs 2 and 3 are independent systems: Lingui catalogs (`.po` files, shipped in
the bundle) for the admin chrome, the `i18n_strings` table for content.
