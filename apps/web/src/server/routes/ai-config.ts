import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { enforceIpRateLimit } from "../lib/auth-rate-limit";
import { cloudConfigured } from "../lib/cloud-report";
import { callClaude } from "../mcp/ai-client";
import { defaultHook } from "../lib/openapi-router";
import {
  GLOBAL_AI_CONFIG_ID,
  resolveAiRuntime,
} from "../services/ai-config";
import {
  mergeConfigSecrets,
  readOwnConfigRow,
  saveOwnConfigRow,
  tenantKey,
} from "../services/provider-config";
import {
  AI_MODELS,
  AI_PROVIDERS,
  AI_PROVIDER_IDS,
  isAiSecretKey,
  modelsForProvider,
} from "../services/ai-providers";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.aiConfig : sqlite.schema.aiConfig;

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

// Registry-driven, so adding a provider to `services/ai-providers.ts` widens
// the accepted enum without touching this file.
const AiProvider = z.enum(AI_PROVIDER_IDS as [string, ...string[]]);

const secretKeyList = AI_PROVIDERS.map((p) => `\`${p.secretKey}\``).join(", ");

const PutInput = z
  .object({
    provider: AiProvider,
    /** Non-secret params (currently just an optional default `model` id).
     *  Replaces the stored `config` wholesale. */
    config: z.record(z.string(), z.unknown()).optional(),
    /** Per-key plaintext secret. Non-empty string = encrypt + store;
     *  empty/null = clear; omitted = left untouched. */
    secrets: z
      .record(z.string(), z.union([z.string(), z.null()]))
      .optional()
      .openapi({
        description: `Per-key plaintext AI key (${secretKeyList}). Non-empty = encrypt + store; empty/null = clear; omitted keys left untouched.`,
      }),
  })
  .openapi("AiConfigPutInput");

const AiTestInput = z.object({}).openapi("AiConfigTestInput");

/**
 * Which secret keys have a stored ciphertext — a boolean per registry provider,
 * never the ciphertext and never the plaintext. This is the ONLY thing the read
 * endpoint says about a stored key.
 */
const secretsSet = (
  stored: Record<string, string> | null | undefined,
): Record<string, boolean> => {
  const s = stored ?? {};
  const out: Record<string, boolean> = {};
  for (const p of AI_PROVIDERS) {
    const v = s[p.secretKey];
    out[p.secretKey] = typeof v === "string" && v.length > 0;
  }
  return out;
};

const tags = ["ai-config"];
const adminGate = [requireUser, requireAdmin];

export const aiConfigRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "Read the workspace AI provider config",
      description:
        "Returns the active workspace's bring-your-own AI key config. Secret values are never returned — only a per-key 'is it set' flag.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.any() } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = auth.tenantId ?? GLOBAL_AI_CONFIG_ID;
      const row = await readOwnConfigRow<{
        provider: string;
        config: Record<string, unknown> | null;
        secrets: Record<string, string> | null;
        updatedAt: unknown;
      }>(ctx, tableFor(ctx.dialect), tenantKey(tableFor(ctx.dialect), tenantId));
      return c.json({
        data: {
          tenantId,
          provider: row?.provider ?? "inherit",
          config: row?.config ?? {},
          secretsSet: secretsSet(row?.secrets),
          updatedAt: row?.updatedAt ?? null,
          /** Deployment-level context for the UI: on managed cloud, "inherit"
           *  routes through the metered platform AI gateway; on self-host it
           *  uses the env keys (if any). */
          env: {
            cloud: cloudConfigured(ctx.env),
            hasGatewayKey: Boolean(ctx.env.AI_GATEWAY_API_KEY?.trim()),
            // An OAuth bearer token counts: the UI only asks "can BYO models
            // actually run here", and it can.
            hasAnthropicKey: Boolean(
              ctx.env.ANTHROPIC_API_KEY?.trim() || ctx.env.ANTHROPIC_AUTH_TOKEN?.trim(),
            ),
          },
          providerIds: AI_PROVIDER_IDS,
          /** Provider registry — what the picker renders. Descriptive metadata
           *  only; no credential material of any kind crosses this boundary,
           *  `envKey` is just the NAME of the variable an operator would set. */
          providers: AI_PROVIDERS.map((p) => ({
            id: p.id,
            label: p.label,
            secretKey: p.secretKey,
            secretLabel: p.secretLabel,
            envKey: p.envKey,
            transport: p.transport,
            defaultModel: p.defaultModel,
            hint: p.hint,
            docsUrl: p.docsUrl,
          })),
          /** Full model catalog plus, for convenience, the ids each provider
           *  can actually run — so the admin can filter the dropdown the moment
           *  the provider changes without a second round-trip. */
          models: AI_MODELS,
          modelsByProvider: Object.fromEntries(
            AI_PROVIDER_IDS.map((id) => [id, modelsForProvider(id).map((m) => m.id)]),
          ),
        },
      });
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/",
      tags,
      summary: "Upsert the workspace AI provider config",
      description:
        "Plaintext keys are encrypted (AES-256-GCM, key derived from `AUTH_SECRET`) before storage.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: PutInput } },
        },
      },
      responses: {
        200: {
          description: "Saved",
          content: { "application/json": { schema: OkSchema } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const body = c.req.valid("json");
      const tenantId = auth.tenantId ?? GLOBAL_AI_CONFIG_ID;
      const t = tableFor(ctx.dialect);

      const existing = await readOwnConfigRow<{
        secrets: Record<string, string> | null;
      }>(ctx, t, tenantKey(t, tenantId));

      // Registry-gated rather than a fixed tuple: the AI provider set is a
      // registry, so the predicate form of `allowed` is what scopes it. An
      // unrecognised key is dropped, never written through.
      const secrets = await mergeConfigSecrets({
        stored: existing?.secrets,
        patch: body.secrets,
        allowed: isAiSecretKey,
        authSecret: ctx.env.AUTH_SECRET,
      });

      // An omitted column means "leave it alone" on an existing row and "use
      // the empty default" on a new one, so it belongs to `onCreate` rather
      // than `always`.
      const always: Record<string, unknown> = { provider: body.provider, secrets };
      const onCreate: Record<string, unknown> = { config: {} };
      if (body.config !== undefined) always.config = body.config;

      await saveOwnConfigRow(ctx, t, tenantKey(t, tenantId), { always, onCreate });
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/test",
      tags,
      summary: "Verify the stored AI key with a tiny generation call",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: false,
          content: { "application/json": { schema: AiTestInput } },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean(), reply: z.string() }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      // Cap per-IP so an admin cookie can't be turned into a free generation
      // pipe (or rack up provider costs) by hammering this endpoint.
      await enforceIpRateLimit(c, "ai-test", 5);
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      // Same shared resolution path every other AI caller uses, so "Test key"
      // proves the config that will actually run — provider AND model.
      const { env, model } = await resolveAiRuntime(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        auth.tenantId ?? GLOBAL_AI_CONFIG_ID,
      );
      const reply = await callClaude(env, {
        user: "Reply with exactly the word: ok",
        model,
        maxTokens: 16,
      });
      return c.json({ ok: true, reply: reply.text.trim().slice(0, 200) });
    },
  );
