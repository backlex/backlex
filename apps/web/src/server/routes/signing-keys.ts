/**
 * Signing keys — admin routes. Mounted at `/api/admin/signing-keys`.
 *
 * Instance-level, not per workspace: the JWKS is one document at one URL and a
 * token's `iss` names the instance. The gate is therefore the INSTANCE
 * OPERATOR, and no tenant is required. It is deliberately not the workspace
 * `admin` role — see the comment on `adminGate` below.
 *
 * Nothing here returns a private key. `generate` does not return one either —
 * unlike an API key or an S3 secret, nobody ever needs to hold it: it exists to
 * sign, the public half is published, and the only legitimate copy lives in the
 * row.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { requireOperatorMw } from "../services/roles/guards";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  deleteSigningKey,
  generateSigningKey,
  importSigningKey,
  listSigningKeys,
  promoteSigningKey,
  restoreSigningKey,
  revokeSigningKey,
} from "../services/signing-keys";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

const View = z
  .object({
    id: z.string(),
    kid: z.string(),
    alg: z.enum(["ES256", "RS256"]),
    status: z.enum(["standby", "in_use", "previously_used", "revoked"]),
    note: z.string().nullable(),
    createdAt: z.number().nullable(),
    activatedAt: z.number().nullable(),
    retiredAt: z.number().nullable(),
    revokedAt: z.number().nullable(),
    published: z.boolean(),
  })
  .openapi("SigningKey");

/** Instance operator, not the workspace `admin` role.
 *
 *  The keyring is one list for the whole instance — `services/signing-keys.ts`
 *  never reads `tenantId`, `dbKeyMaterial` loads every row, and the `in_use`
 *  row signs the access token of every workspace's end-users. The `admin` role
 *  is self-serve (`POST /api/tenants` grants it to whoever creates a
 *  workspace — routes/tenants.ts:758, and `WORKSPACE_CREATION` defaults to
 *  `open`), so gating on it let any signed-up user import a private key they
 *  hold and then mint app-plane tokens for every OTHER workspace. Same gate
 *  routes/db-admin.ts puts on the SQL console, for the same reason. */
const adminGate = [requireUser, requireOperatorMw];

const tags = ["signing-keys"];

export const signingKeysRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List signing keys",
      description:
        "Private halves are never included. `published` is whether the key's public half is " +
        "currently in `/.well-known/jwks.json`.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: z.array(View) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await listSigningKeys(c.get("ctx")) }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Generate a key",
      description:
        "Created in `standby`: published in the JWKS, signing nothing. That order is not optional — " +
        "verifiers cache the JWKS, so a key that started signing the moment it existed would mint " +
        "tokens nobody could verify until their cache expired. Promote it once it has propagated.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z
                .object({
                  alg: z.enum(["ES256", "RS256"]).optional(),
                  note: z.string().max(200).nullish(),
                })
                .openapi("SigningKeyGenerateInput"),
            },
          },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: View }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const data = await generateSigningKey(c.get("ctx"), c.req.valid("json"));
      await logActivity(c, {
        action: "create",
        collection: "system_signing_keys",
        itemId: data.id,
        payload: { kid: data.kid, alg: data.alg },
      });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/import",
      tags,
      summary: "Import an existing private key",
      description:
        "Takes a PKCS#8 PEM — including the one currently in `AUTH_JWT_PRIVATE_KEY`, which is how " +
        "a deployment moves off environment variables without invalidating a single live token. " +
        "Stored as `standby`; promote it to start signing from the row instead.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z
                .object({ privateKey: z.string().min(1), note: z.string().max(200).nullish() })
                .openapi("SigningKeyImportInput"),
            },
          },
        },
      },
      responses: {
        201: {
          description: "Imported",
          content: { "application/json": { schema: z.object({ data: View }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const data = await importSigningKey(c.get("ctx"), body.privateKey, body.note);
      await logActivity(c, {
        action: "create",
        collection: "system_signing_keys",
        itemId: data.id,
        // The kid identifies the key; the key itself is never logged.
        payload: { kid: data.kid, alg: data.alg, imported: true },
      });
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/promote",
      tags,
      summary: "Sign with this key from now on",
      description:
        "The current key is demoted to `previously_used` in the same operation — two keys in use " +
        "would make 'which one signs' a question about row order. Rolling back is promoting the " +
        "other one again.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: View }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const data = await promoteSigningKey(c.get("ctx"), id);
      await logActivity(c, {
        action: "update",
        collection: "system_signing_keys",
        itemId: id,
        payload: { promoted: data.kid },
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/revoke",
      tags,
      summary: "Remove a key from the JWKS",
      description:
        "Tokens it signed stop verifying — here within ten seconds, and for external verifiers " +
        "whenever their JWKS cache expires. Refused for the key currently in use.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: View }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const data = await revokeSigningKey(c.get("ctx"), id);
      await logActivity(c, {
        action: "update",
        collection: "system_signing_keys",
        itemId: id,
        payload: { revoked: data.kid },
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/restore",
      tags,
      summary: "Undo a revocation",
      description:
        "Back to `previously_used` if it ever signed, `standby` if it did not. Every transition is " +
        "reversible — that is why the states exist rather than a delete button.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: View }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const data = await restoreSigningKey(c.get("ctx"), id);
      await logActivity(c, {
        action: "update",
        collection: "system_signing_keys",
        itemId: id,
        payload: { restored: data.kid },
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete a revoked key",
      description:
        "Only a revoked key. Anything else still verifies tokens somebody is holding.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await deleteSigningKey(c.get("ctx"), id);
      await logActivity(c, {
        action: "delete",
        collection: "system_signing_keys",
        itemId: id,
      });
      return c.json({ ok: true });
    },
  );
