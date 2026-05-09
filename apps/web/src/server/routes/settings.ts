import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.appSettings : sqlite.schema.appSettings;

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const SettingsInput = z.record(z.unknown());

export const settingsRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    await next();
  })
  /** Returns all settings for the active tenant as a flat key→value map. */
  .get("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const t = tableFor(ctx.dialect);
    const rows = (await (ctx.db as any)
      .select()
      .from(t)
      .where(
        auth.tenantId ? eq(t.tenantId, auth.tenantId) : isNull(t.tenantId),
      )) as { key: string; value: unknown }[];
    const data: Record<string, unknown> = {
      siteName: "workeros",
      appUrl: ctx.env.APP_URL,
      emailFrom: ctx.env.EMAIL_FROM ?? null,
      openSignup: true,
      telemetry: false,
    };
    for (const r of rows) data[r.key] = r.value;
    return c.json({ data });
  })
  /** Patch a settings bundle; merges into the existing key/value rows. */
  .patch("/", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = SettingsInput.parse(await c.req.json());
    const t = tableFor(ctx.dialect);
    for (const [key, value] of Object.entries(body)) {
      const existing = (await (ctx.db as any)
        .select({ id: t.id })
        .from(t)
        .where(
          and(
            eq(t.key, key),
            auth.tenantId ? eq(t.tenantId, auth.tenantId) : isNull(t.tenantId),
          ),
        )
        .limit(1)) as { id: string }[];
      if (existing[0]) {
        await (ctx.db as any)
          .update(t)
          .set({ value, updatedAt: ctx.dialect === "pg" ? new Date() : Date.now() })
          .where(eq(t.id, existing[0].id));
      } else {
        await (ctx.db as any).insert(t).values({
          id: crypto.randomUUID(),
          tenantId: auth.tenantId ?? null,
          key,
          value,
        });
      }
    }
    return c.json({ ok: true });
  })
  /**
   * Read-only runtime info: which env vars are set, which bindings are
   * present, package version. The Settings → Bindings/Environment tabs
   * read this — they never write back (those changes happen via
   * `wrangler.toml` + redeploy).
   */
  .get("/runtime", async (c) => {
    const ctx = c.get("ctx");
    const env = ctx.env as unknown as Record<string, unknown>;
    const present = (k: string) => env[k] !== undefined && env[k] !== null && env[k] !== "";
    const bindings = [
      { type: "D1", name: "D1", target: "workeros-db", status: env.D1 ? "connected" : "optional" },
      { type: "R2", name: "R2", target: "workeros-assets", status: env.R2 ? "connected" : "optional" },
      { type: "DurableObj", name: "REALTIME", target: "RealtimeRoom", status: env.REALTIME ? "connected" : "optional" },
      { type: "Vectorize", name: "VECTORIZE", target: "embeddings-1536", status: env.VECTORIZE ? "connected" : "optional" },
      { type: "Hyperdrive", name: "HYPERDRIVE", target: "pg-pool", status: env.HYPERDRIVE ? "connected" : "optional" },
    ];
    const envVars = [
      { key: "APP_URL", set: present("APP_URL"), source: "env", secret: false },
      { key: "DATABASE_URL", set: present("DATABASE_URL"), source: "env", secret: true },
      { key: "AUTH_SECRET", set: present("AUTH_SECRET"), source: "env", secret: true },
      { key: "RESEND_API_KEY", set: present("RESEND_API_KEY"), source: "env", secret: true },
      { key: "EMAIL_FROM", set: present("EMAIL_FROM"), source: "env", secret: false },
      { key: "OAUTH_GOOGLE_CLIENT_ID", set: present("OAUTH_GOOGLE_CLIENT_ID"), source: "env", secret: false },
      { key: "OAUTH_GOOGLE_CLIENT_SECRET", set: present("OAUTH_GOOGLE_CLIENT_SECRET"), source: "env", secret: true },
      { key: "OAUTH_GITHUB_CLIENT_ID", set: present("OAUTH_GITHUB_CLIENT_ID"), source: "env", secret: false },
      { key: "OAUTH_GITHUB_CLIENT_SECRET", set: present("OAUTH_GITHUB_CLIENT_SECRET"), source: "env", secret: true },
      { key: "S3_BUCKET", set: present("S3_BUCKET"), source: "env", secret: false },
    ];
    const adapter = env.D1 ? "workers" : env.DATABASE_URL ? "vercel" : "bun";
    return c.json({
      data: {
        adapter,
        dialect: ctx.dialect,
        bindings,
        envVars,
        version: "v0.9.4",
      },
    });
  });
