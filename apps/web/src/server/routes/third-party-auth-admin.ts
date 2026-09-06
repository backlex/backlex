/**
 * Third-party issuer admin CRUD. Admin-only, scoped to the active workspace.
 * Mounted at `/api/admin/third-party-auth`. Shape mirrors `routes/saml-admin.ts`.
 *
 * Endpoints:
 *   - `GET    /providers`          — list
 *   - `POST   /providers`          — create (resolves `jwks_uri` via discovery)
 *   - `PATCH  /providers/{id}`     — partial update
 *   - `DELETE /providers/{id}`     — remove (external_identities are kept, so
 *                                    re-adding the issuer re-links the same
 *                                    people rather than duplicating them)
 *   - `POST   /providers/{id}/test` — verify a pasted token and report what the
 *                                    claim mapping extracted, without
 *                                    provisioning anything
 *
 * Nothing here is a secret: verifying a third-party token needs only the
 * issuer's public keys, so unlike SAML there is no ciphertext to sanitize out
 * of a response.
 */
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { defaultHook } from "../lib/openapi-router";
import { SECURITY, errorResponses, httpUrl } from "../lib/openapi";
import { verifyThirdPartyToken } from "../lib/third-party-jwt";
import { requireUser } from "../middleware/session";
import {
  createThirdPartyProvider,
  deleteThirdPartyProvider,
  listThirdPartyProviders,
  loadThirdPartyProviderById,
  updateThirdPartyProvider,
} from "../services/third-party-auth";

const requireAdminWorkspaceMw: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  if (!auth.tenantId) {
    throw new AppError("VALIDATION", "Active workspace required");
  }
  await next();
};

const CreateInput = z
  .object({
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(60).optional(),
    /** Exact `iss` value the issuer stamps on its tokens. */
    issuer: z.string().min(1).max(512),
    jwksUrl: httpUrl().optional(),
    discoveryUrl: httpUrl().nullable().optional(),
    audience: z.string().min(1).max(512).nullable().optional(),
    subjectClaim: z.string().min(1).max(120).optional(),
    emailClaim: z.string().min(1).max(120).optional(),
    nameClaim: z.string().min(1).max(120).nullable().optional(),
    groupsClaim: z.string().min(1).max(120).nullable().optional(),
    groupsToRoles: z.record(z.string(), z.string()).nullable().optional(),
    defaultRoleId: z.string().min(1).nullable().optional(),
    linkByVerifiedEmail: z.boolean().optional(),
    autoProvision: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("ThirdPartyAuthProviderInput");

const PatchInput = CreateInput.partial().openapi("ThirdPartyAuthProviderPatch");

const TestInput = z
  .object({ token: z.string().min(1) })
  .openapi("ThirdPartyAuthTestInput");

const TAG = "third-party-auth";

export const thirdPartyAuthAdminRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/providers",
      tags: [TAG],
      summary: "List trusted third-party issuers",
      description:
        "Issuers whose JWTs this workspace accepts directly (Clerk, Auth0, Firebase, Cognito, WorkOS).",
      security: SECURITY,
      middleware: [requireUser, requireAdminWorkspaceMw],
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
      const rows = await listThirdPartyProviders(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        auth.tenantId!,
      );
      return c.json({ data: rows });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/providers",
      tags: [TAG],
      summary: "Trust a third-party issuer",
      description:
        "When `discoveryUrl` is given, `jwks_uri` is resolved from it at save time and stored, so the request path never re-resolves discovery.",
      security: SECURITY,
      middleware: [requireUser, requireAdminWorkspaceMw],
      request: {
        body: { required: true, content: { "application/json": { schema: CreateInput } } },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.any() } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const row = await createThirdPartyProvider(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        auth.tenantId!,
        c.req.valid("json"),
      );
      return c.json({ data: row }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/providers/{id}",
      tags: [TAG],
      summary: "Update a trusted issuer",
      description: "Partial update. Omitted fields keep their stored values.",
      security: SECURITY,
      middleware: [requireUser, requireAdminWorkspaceMw],
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: PatchInput } } },
      },
      responses: {
        200: {
          description: "Updated",
          content: { "application/json": { schema: z.any() } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      if (!id) throw new AppError("VALIDATION", "Provider id required");
      const row = await updateThirdPartyProvider(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        auth.tenantId!,
        id,
        c.req.valid("json"),
      );
      if (!row) throw new AppError("NOT_FOUND", "Provider not found");
      return c.json({ data: row });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/providers/{id}",
      tags: [TAG],
      summary: "Stop trusting an issuer",
      description:
        "Existing `external_identities` links are kept, so re-adding the issuer re-links the same people instead of provisioning duplicates.",
      security: SECURITY,
      middleware: [requireUser, requireAdminWorkspaceMw],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "Deleted",
          content: { "application/json": { schema: z.any() } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      if (!id) throw new AppError("VALIDATION", "Provider id required");
      const ok = await deleteThirdPartyProvider(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        auth.tenantId!,
        id,
      );
      if (!ok) throw new AppError("NOT_FOUND", "Provider not found");
      return c.json({ data: { ok: true } });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/providers/{id}/test",
      tags: [TAG],
      summary: "Test a token against this issuer",
      description:
        "Verifies a pasted token and reports what the claim mapping extracted. Provisions nothing and creates no session — the setup path for 'why is my token rejected'.",
      security: SECURITY,
      middleware: [requireUser, requireAdminWorkspaceMw],
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: TestInput } } },
      },
      responses: {
        200: {
          description: "Verification result",
          content: { "application/json": { schema: z.any() } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const { id } = c.req.valid("param");
      if (!id) throw new AppError("VALIDATION", "Provider id required");
      const provider = await loadThirdPartyProviderById(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        auth.tenantId!,
        id,
      );
      if (!provider) throw new AppError("NOT_FOUND", "Provider not found");

      const identity = await verifyThirdPartyToken(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        c.req.valid("json").token,
      );
      // `verifyThirdPartyToken` resolves the provider from the token's own
      // issuer, instance-wide. When that lands on a row this workspace does not
      // own, the answer must not name it: on a shared instance that would
      // disclose another tenant's configuration to whoever can paste a token —
      // the same leak `assertIssuerFree` deliberately avoids on create. Both
      // cases collapse into one indistinguishable response.
      if (!identity || identity.provider.id !== provider.id) {
        return c.json({
          data: {
            valid: false,
            reason:
              "Signature, expiry, audience or issuer did not match this provider",
          },
        });
      }
      return c.json({
        data: {
          valid: true,
          subject: identity.subject,
          email: identity.email,
          name: identity.name,
          groups: identity.groups,
          wouldProvision: identity.email !== null || !provider.autoProvision,
        },
      });
    },
  );
