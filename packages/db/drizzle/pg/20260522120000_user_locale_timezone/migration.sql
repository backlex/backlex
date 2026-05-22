-- Per-user UI preferences: BCP-47 locale + IANA time zone. Both nullable —
-- NULL means "inherit the workspace default" (`app_settings.i18nDefaultLocale`
-- / `app_settings.timezone`). Resolved by `routes/account.ts` and surfaced to
-- the admin SPA via `GET /api/account/preferences`.
ALTER TABLE "users" ADD COLUMN "locale" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "timezone" text;
