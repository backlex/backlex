/**
 * Control-plane SAML provider admin CRUD. Admin-only, instance-global (no
 * workspace). Mounted at `/api/admin/platform-saml`. Fork of `saml-admin.ts`
 * against the platform data layer. Gated by `PLATFORM_SSO_ENABLED`.
 *
 *   - `GET    /providers`                    — list (sanitized)
 *   - `POST   /providers`                    — create
 *   - `PATCH  /providers/{id}`               — partial update
 *   - `DELETE /providers/{id}`               — remove
 *   - `POST   /providers/{id}/test-assertion`— debug parse, no provisioning
 *   - `POST   /providers/import-metadata`    — parse IdP metadata XML
 *
 * No tenant-auth cache to invalidate — `resolvePlatformSamlProvider` reads the
 * row fresh on every SSO request.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import { isPlatformSsoEnabled } from "../lib/platform-sso";
import { parseMetadataXml } from "./saml-admin";
import {
  buildPlatformAcsAndMetadataUrls,
  createPlatformSamlProvider,
  deletePlatformSamlProvider,
  listPlatformSamlProviders,
  loadPlatformSamlProviderById,
  resolvePlatformSamlProvider,
  sanitizeForResponse,
  updatePlatformSamlProvider,
} from "../services/platform-saml-providers";

/** Admin gate + feature flag. No active-workspace requirement (instance-global). */
const gate: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!isPlatformSsoEnabled(c.get("ctx").env)) {
    throw new AppError("NOT_FOUND", "Platform SSO is not enabled");
  }
  if (!c.get("auth").roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

const AttributeMap = z
  .object({
    email: z.string().min(1).optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    groups: z.string().min(1).optional(),
  })
  .catchall(z.string())
  .openapi("PlatformSamlAttributeMap");

const CreateInput = z
  .object({
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(60).optional(),
    idpTemplate: z
      .enum(["okta", "azure", "google", "adfs", "jumpcloud", "auth0"])
      .nullable()
      .optional(),
    entityId: z.string().min(1).url().or(z.string().min(1)),
    ssoUrl: z.string().url(),
    sloUrl: z.string().url().nullable().optional(),
    idpCertPem: z.string().min(20),
    spEntityId: z.string().min(1),
    attributeMap: AttributeMap.optional(),
    defaultRoleId: z.string().min(1).nullable().optional(),
    groupsToRoles: z
      .record(z.string(), z.object({ tenantId: z.string(), roleId: z.string() }))
      .nullable()
      .optional(),
    signatureAlgorithm: z.enum(["sha1", "sha256", "sha512"]).optional(),
    wantSignedAssertions: z.boolean().optional(),
    linkByVerifiedEmail: z.boolean().optional(),
    nameIdFormat: z.string().min(1).optional(),
    domainMatch: z.array(z.string().min(1)).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("PlatformSamlProviderInput");

const PatchInput = CreateInput.partial().openapi("PlatformSamlProviderPatch");

const TestAssertionInput = z
  .object({ samlResponse: z.string().min(1) })
  .openapi("PlatformSamlTestAssertionInput");

const ImportMetadataInput = z
  .object({
    metadataXml: z.string().min(1).optional(),
    metadataUrl: z.string().url().optional(),
  })
  .openapi("PlatformSamlImportMetadataInput");

const TAG = "platform-saml-admin";
const GATE: MiddlewareHandler<AppBindings>[] = [requireUser, gate];

const pickMapped = (attrs: Record<string, string[]>, key: string): string | null =>
  attrs[key]?.[0] ?? null;

export const platformSamlAdminRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/providers",
      tags: [TAG],
      summary: "List platform SAML providers",
      security: SECURITY,
      middleware: GATE,
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.any() } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const rows = await listPlatformSamlProviders({ db: ctx.db, dialect: ctx.dialect });
      return c.json({ data: rows.map(sanitizeForResponse) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/providers",
      tags: [TAG],
      summary: "Create platform SAML provider",
      security: SECURITY,
      middleware: GATE,
      request: {
        body: { required: true, content: { "application/json": { schema: CreateInput } } },
      },
      responses: {
        201: { description: "Created", content: { "application/json": { schema: z.any() } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const body = c.req.valid("json");
      const row = await createPlatformSamlProvider(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        {
          name: body.name,
          slug: body.slug,
          idpTemplate: body.idpTemplate ?? null,
          entityId: body.entityId,
          ssoUrl: body.ssoUrl,
          sloUrl: body.sloUrl ?? null,
          idpCertPem: body.idpCertPem,
          spEntityId: body.spEntityId,
          attributeMap: body.attributeMap ?? {},
          defaultRoleId: body.defaultRoleId ?? null,
          groupsToRoles: body.groupsToRoles ?? null,
          signatureAlgorithm: body.signatureAlgorithm,
          wantSignedAssertions: body.wantSignedAssertions,
          linkByVerifiedEmail: body.linkByVerifiedEmail,
          nameIdFormat: body.nameIdFormat,
          domainMatch: body.domainMatch ?? null,
          enabled: body.enabled,
        },
      );
      return c.json({ data: sanitizeForResponse(row) }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/providers/{id}",
      tags: [TAG],
      summary: "Update platform SAML provider",
      security: SECURITY,
      middleware: GATE,
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: PatchInput } } },
      },
      responses: {
        200: { description: "Updated", content: { "application/json": { schema: z.any() } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { id } = c.req.valid("param");
      if (!id) throw new AppError("VALIDATION", "Provider id required");
      const row = await updatePlatformSamlProvider(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        id,
        c.req.valid("json"),
      );
      if (!row) throw new AppError("NOT_FOUND", "Provider not found");
      return c.json({ data: sanitizeForResponse(row) });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/providers/{id}",
      tags: [TAG],
      summary: "Delete platform SAML provider",
      security: SECURITY,
      middleware: GATE,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { id } = c.req.valid("param");
      if (!id) throw new AppError("VALIDATION", "Provider id required");
      const existing = await loadPlatformSamlProviderById({ db: ctx.db, dialect: ctx.dialect }, id);
      if (!existing) throw new AppError("NOT_FOUND", "Provider not found");
      await deletePlatformSamlProvider({ db: ctx.db, dialect: ctx.dialect }, id);
      return c.json({ ok: true });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/providers/{id}/test-assertion",
      tags: [TAG],
      summary: "Test a SAMLResponse",
      security: SECURITY,
      middleware: GATE,
      request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: TestAssertionInput } } },
      },
      responses: {
        200: { description: "Parsed assertion", content: { "application/json": { schema: z.any() } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { id } = c.req.valid("param");
      if (!id) throw new AppError("VALIDATION", "Provider id required");
      const body = c.req.valid("json");
      const row = await loadPlatformSamlProviderById({ db: ctx.db, dialect: ctx.dialect }, id);
      if (!row) throw new AppError("NOT_FOUND", "Provider not found");
      const resolved = await resolvePlatformSamlProvider(
        { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
        row.slug,
      );
      if (!resolved) throw new AppError("INTERNAL", "Provider config could not be resolved");
      let assertion;
      try {
        assertion = await resolved.adapter.verifyAssertion(resolved.cfg, body.samlResponse);
      } catch (err) {
        throw new AppError(
          "VALIDATION",
          `SAML verification failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return c.json({
        data: {
          nameId: assertion.nameId,
          issuer: assertion.issuer,
          audience: assertion.audience,
          attributes: assertion.attributes,
          mapped: {
            email: pickMapped(assertion.attributes, row.attributeMap.email ?? "email"),
            firstName: pickMapped(assertion.attributes, row.attributeMap.firstName ?? "firstName"),
            lastName: pickMapped(assertion.attributes, row.attributeMap.lastName ?? "lastName"),
            groups: assertion.attributes[row.attributeMap.groups ?? "groups"] ?? [],
          },
        },
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/providers/import-metadata",
      tags: [TAG],
      summary: "Parse IdP metadata XML",
      security: SECURITY,
      middleware: GATE,
      request: {
        body: { required: true, content: { "application/json": { schema: ImportMetadataInput } } },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.any() } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const body = c.req.valid("json");
      if (!body.metadataXml && !body.metadataUrl) {
        throw new AppError("VALIDATION", "Provide metadataXml or metadataUrl");
      }
      let xml = body.metadataXml ?? "";
      if (!xml && body.metadataUrl) {
        const res = await fetch(body.metadataUrl);
        if (!res.ok) throw new AppError("VALIDATION", `Metadata fetch returned ${res.status}`);
        xml = await res.text();
      }
      const parsed = parseMetadataXml(xml);
      const { metadataUrl } = buildPlatformAcsAndMetadataUrls(ctx.env, "imported");
      return c.json({ data: { ...parsed, spEntityIdSuggested: metadataUrl } });
    },
  );
