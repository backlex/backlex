import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import {
  GLOBAL_WORKSPACE_CONFIG_ID,
  isValidColor,
  loadWorkspaceConfigRow,
  resolveWorkspaceConfig,
  type WorkspaceConfigRow,
} from "../services/workspace-config";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.workspaceConfig : sqlite.schema.workspaceConfig;

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const optionalString = z.union([z.string(), z.null()]).optional();

const PutInput = z.object({
  workspaceName: optionalString,
  description: optionalString,
  logoFileKey: optionalString,
  faviconFileKey: optionalString,
  /** Hex (`#rrggbb`), or a CSS color function (`rgb()`, `hsl()`, `oklch()`,
   *  `oklab()`). The exact string lands as the `--primary` token; the format
   *  whitelist keeps a hostile admin from breaking out of the `<style>` tag
   *  at boot. Pass `""` / `null` to clear and fall back to the bundled token. */
  primaryColor: z
    .union([
      z.string().refine((v) => v === "" || isValidColor(v), {
        message:
          "primary_color must be a hex (`#rrggbb`) or a CSS color function (`rgb()`, `hsl()`, `oklch()`, `oklab()`)",
      }),
      z.null(),
    ])
    .optional(),
  defaultTheme: z
    .union([z.enum(["light", "dark", "system"]), z.literal(""), z.null()])
    .optional(),
});

/** Drop a stored field back to NULL when the PUT body sets it to "" or null. */
const normalizeNullable = (v: string | null | undefined): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
};

export const workspaceConfigRoutes = new Hono<AppBindings>()
  /**
   * Resolved view of the active workspace's branding — public so the login
   * page and other unauthenticated screens can pick up the logo/title. The
   * workspace's own row layers onto the `_global` row; missing fields fall
   * through. Never returns the raw rows.
   */
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const resolved = await resolveWorkspaceConfig(ctx, auth.tenantId ?? null);
    return c.json({ data: resolved });
  })
  /**
   * Read the current workspace's *own* `workspace_config` row (no `_global`
   * fallback) — used by the admin Settings UI so it edits the workspace's row
   * specifically, not the inherited values.
   */
  .get("/raw", requireUser, async (c) => {
    requireAdmin(c.get("auth"));
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = auth.tenantId ?? GLOBAL_WORKSPACE_CONFIG_ID;
    const row = await loadWorkspaceConfigRow(ctx, tenantId);
    return c.json({
      data: {
        tenantId,
        workspaceName: row?.workspaceName ?? null,
        description: row?.description ?? null,
        logoFileKey: row?.logoFileKey ?? null,
        faviconFileKey: row?.faviconFileKey ?? null,
        primaryColor: row?.primaryColor ?? null,
        defaultTheme: row?.defaultTheme ?? null,
        updatedAt: row?.updatedAt ?? null,
      },
    });
  })
  /**
   * Upsert the active workspace's `workspace_config`. Omitted fields are left
   * untouched; passing `""` or `null` clears a field back to its design-system
   * default (which then falls through to `_global` and finally to the bundled
   * tokens).
   */
  .put("/", requireUser, async (c) => {
    requireAdmin(c.get("auth"));
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = PutInput.parse(await c.req.json());
    const tenantId = auth.tenantId ?? GLOBAL_WORKSPACE_CONFIG_ID;
    const t = tableFor(ctx.dialect);

    const existing = (await (ctx.db as any)
      .select()
      .from(t)
      .where(eq(t.tenantId, tenantId))
      .limit(1)) as WorkspaceConfigRow[];

    const fields: Record<string, string | null | undefined> = {
      workspaceName: normalizeNullable(body.workspaceName),
      description: normalizeNullable(body.description),
      logoFileKey: normalizeNullable(body.logoFileKey),
      faviconFileKey: normalizeNullable(body.faviconFileKey),
      primaryColor: normalizeNullable(body.primaryColor),
      defaultTheme: normalizeNullable(body.defaultTheme),
    };

    if (existing[0]) {
      const set: Record<string, unknown> = {
        updatedAt: ctx.dialect === "pg" ? new Date() : Date.now(),
      };
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) set[k] = v;
      }
      await (ctx.db as any).update(t).set(set).where(eq(t.tenantId, tenantId));
    } else {
      await (ctx.db as any).insert(t).values({
        tenantId,
        workspaceName: fields.workspaceName ?? null,
        description: fields.description ?? null,
        logoFileKey: fields.logoFileKey ?? null,
        faviconFileKey: fields.faviconFileKey ?? null,
        primaryColor: fields.primaryColor ?? null,
        defaultTheme: fields.defaultTheme ?? null,
      });
    }

    return c.json({ ok: true });
  })
  /**
   * Stream the active workspace's logo or favicon, no auth required (branding
   * needs to render on the sign-in screen too). Returns 404 when the
   * workspace's own row has no key for that asset — we deliberately don't
   * fall back to `_global` here because the file would have to live in the
   * `_global` "tenant" bucket, which isn't a real workspace.
   */
  .get("/asset/:kind{logo|favicon}", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const kind = c.req.param("kind") as "logo" | "favicon";
    const tenantId = auth.tenantId ?? null;
    if (!tenantId) throw new AppError("NOT_FOUND", "No active workspace");
    const row = await loadWorkspaceConfigRow(ctx, tenantId);
    const logical = kind === "logo" ? row?.logoFileKey : row?.faviconFileKey;
    if (!logical) throw new AppError("NOT_FOUND", `No ${kind} configured`);
    // Same prefix scheme as `routes/storage.ts` — keep in sync if it changes.
    const physical = `tenants/${tenantId}/${logical}`;
    const obj = await ctx.storage.get(physical);
    if (!obj) throw new AppError("NOT_FOUND", `${kind} file missing`);
    return new Response(obj.body, {
      headers: {
        "content-type": obj.meta.contentType ?? "application/octet-stream",
        "content-length": String(obj.meta.size),
        // Short cache — admins re-upload at low frequency, and the resolved
        // view appends `?v=<updatedAt>` so a change always busts.
        "cache-control": "public, max-age=300",
      },
    });
  });
