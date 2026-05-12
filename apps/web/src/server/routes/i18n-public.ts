import { Hono } from "hono";
import type { AppBindings } from "../app";
import { loadAppSettings } from "../services/settings";
import { resolveLocaleStrings } from "../services/i18n";

/**
 * Public, unauthenticated i18n read surface — feeds end-user apps and the
 * admin SPA's own UI strings. Scoped by the tenant resolved from the request
 * (host header / `?tenant=`); falls back to global (`tenantId IS NULL`) rows.
 *
 * Cache-Control is set so SDKs can cache locale bundles aggressively; admin
 * upserts don't invalidate the cache, so set a short max-age (60s).
 */
export const i18nPublicRoutes = new Hono<AppBindings>()
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const settings = await loadAppSettings(ctx.db, ctx.dialect, auth.tenantId ?? null);
    c.header("Cache-Control", "public, max-age=60");
    return c.json({
      data: {
        locales: settings.i18nLocales,
        defaultLocale: settings.i18nDefaultLocale,
      },
    });
  })
  .get("/:locale", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const locale = c.req.param("locale");
    const bundle = await resolveLocaleStrings(
      ctx.db,
      ctx.dialect,
      auth.tenantId ?? null,
      locale,
    );
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ data: bundle });
  });
