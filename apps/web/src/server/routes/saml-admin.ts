/**
 * SAML provider admin CRUD. Admin-only, scoped to the active workspace.
 * Mounted at `/api/admin/saml`. Mirrors `routes/email-config.ts` in shape:
 * read returns sanitized rows (no cert PEM, just a flag), writes accept
 * plaintext PEM that the service layer encrypts before storing.
 *
 * Endpoints:
 *   - `GET    /providers`                  — list (sanitized)
 *   - `POST   /providers`                  — create (returns sanitized row)
 *   - `PATCH  /providers/:id`              — partial update
 *   - `DELETE /providers/:id`              — remove (external_identities kept)
 *   - `POST   /providers/:id/test-assertion` — debug: parse without provisioning
 *   - `POST   /providers/import-metadata`  — fetch/parse IdP metadata XML and
 *                                             pre-fill the create form
 *
 * After every mutation we invalidate the cached tenant-auth instance so the
 * next /api/t/:slug/auth/* request picks up the change.
 */
import { Hono } from "hono";
import { z } from "zod";
import { AppError, SYSTEM_ROLES } from "@workeros/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import {
  createSamlProvider,
  deleteSamlProvider,
  listSamlProviders,
  loadSamlProviderById,
  resolveSamlProvider,
  sanitizeForResponse,
  updateSamlProvider,
  buildAcsAndMetadataUrls,
} from "../services/saml-providers";
import { invalidateTenantAuth } from "../services/tenant-auth";

const requireAdmin = (auth: { roles: string[] }) => {
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
};

const AttributeMap = z.object({
  email: z.string().min(1).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  groups: z.string().min(1).optional(),
}).catchall(z.string());

const CreateInput = z.object({
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
  groupsToRoles: z.record(z.string(), z.string()).nullable().optional(),
  signatureAlgorithm: z.enum(["sha1", "sha256", "sha512"]).optional(),
  wantSignedAssertions: z.boolean().optional(),
  linkByVerifiedEmail: z.boolean().optional(),
  nameIdFormat: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

const PatchInput = CreateInput.partial();

const TestAssertionInput = z.object({
  samlResponse: z.string().min(1),
});

const ImportMetadataInput = z
  .object({
    metadataXml: z.string().min(1).optional(),
    metadataUrl: z.string().url().optional(),
  })
  .refine((v) => v.metadataXml || v.metadataUrl, {
    message: "Provide metadataXml or metadataUrl",
  });

interface ImportedMetadata {
  entityId: string;
  ssoUrl: string;
  sloUrl: string | null;
  idpCertPem: string;
}

/**
 * Pull entityID / SSO POST endpoint / signing cert out of a SAML IdP
 * metadata XML document. Intentionally lenient: every real-world IdP
 * emits slightly different metadata, but the four fields we need follow a
 * stable shape. We deliberately don't pull in libxmljs/jsdom — a regex
 * pass is sufficient for the admin pre-fill path (the actual sig check
 * always goes through samlify).
 */
const parseMetadataXml = (xml: string): ImportedMetadata => {
  const entityMatch = xml.match(/<EntityDescriptor\b[^>]*\bentityID="([^"]+)"/);
  const entityId = entityMatch?.[1];
  if (!entityId) throw new AppError("VALIDATION", "Metadata missing EntityDescriptor/@entityID");

  // SingleSignOnService — prefer HTTP-Redirect, fall back to HTTP-POST.
  const ssoMatches = [
    ...xml.matchAll(
      /<SingleSignOnService\b[^>]*\bBinding="([^"]+)"[^>]*\bLocation="([^"]+)"/g,
    ),
  ];
  const ssoRedirect = ssoMatches.find((m) =>
    m[1]?.includes("HTTP-Redirect"),
  );
  const ssoPost = ssoMatches.find((m) => m[1]?.includes("HTTP-POST"));
  const ssoUrl = ssoRedirect?.[2] ?? ssoPost?.[2] ?? ssoMatches[0]?.[2];
  if (!ssoUrl) throw new AppError("VALIDATION", "Metadata missing SingleSignOnService Location");

  const sloMatches = [
    ...xml.matchAll(
      /<SingleLogoutService\b[^>]*\bBinding="([^"]+)"[^>]*\bLocation="([^"]+)"/g,
    ),
  ];
  const sloUrl =
    sloMatches.find((m) => m[1]?.includes("HTTP-Redirect"))?.[2] ??
    sloMatches.find((m) => m[1]?.includes("HTTP-POST"))?.[2] ??
    null;

  // Pull the X509Certificate inside KeyDescriptor[@use="signing"]. The
  // `use` attribute is optional — IdPs that emit a single cert often omit
  // it and use the same key for signing and encryption.
  const certBlock = xml.match(
    /<KeyDescriptor\b(?:[^>]*\buse="signing")?[^>]*>[\s\S]*?<X509Certificate>([\s\S]*?)<\/X509Certificate>[\s\S]*?<\/KeyDescriptor>/,
  );
  const certBody = certBlock?.[1]?.replace(/\s+/g, "") ?? null;
  if (!certBody) {
    throw new AppError("VALIDATION", "Metadata missing X509Certificate");
  }
  const idpCertPem = `-----BEGIN CERTIFICATE-----\n${certBody
    .match(/.{1,64}/g)
    ?.join("\n") ?? certBody}\n-----END CERTIFICATE-----\n`;
  return { entityId, ssoUrl, sloUrl, idpCertPem };
};

export const samlAdminRoutes = new Hono<AppBindings>()
  .use("*", requireUser, async (c, next) => {
    requireAdmin(c.get("auth"));
    const auth = c.get("auth");
    if (!auth.tenantId) {
      throw new AppError("VALIDATION", "Active workspace required for SAML admin");
    }
    await next();
  })
  /** List all SAML providers in the active workspace (sanitized). */
  .get("/providers", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const rows = await listSamlProviders(
      { db: ctx.db, dialect: ctx.dialect },
      auth.tenantId!,
    );
    return c.json({ data: rows.map(sanitizeForResponse) });
  })
  .post("/providers", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const body = CreateInput.parse(await c.req.json());
    // We pre-fill spEntityId with our metadata URL when the caller didn't
    // override — it's the convention most IdPs are happiest with.
    const row = await createSamlProvider(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      auth.tenantId!,
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
        enabled: body.enabled,
      },
    );
    invalidateTenantAuth(auth.tenantId!);
    return c.json({ data: sanitizeForResponse(row) }, 201);
  })
  .patch("/providers/:id", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const id = c.req.param("id");
    if (!id) throw new AppError("VALIDATION", "Provider id required");
    const body = PatchInput.parse(await c.req.json());
    const row = await updateSamlProvider(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      auth.tenantId!,
      id,
      body,
    );
    if (!row) throw new AppError("NOT_FOUND", "Provider not found");
    invalidateTenantAuth(auth.tenantId!);
    return c.json({ data: sanitizeForResponse(row) });
  })
  .delete("/providers/:id", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const id = c.req.param("id");
    if (!id) throw new AppError("VALIDATION", "Provider id required");
    const existing = await loadSamlProviderById(
      { db: ctx.db, dialect: ctx.dialect },
      auth.tenantId!,
      id,
    );
    if (!existing) throw new AppError("NOT_FOUND", "Provider not found");
    await deleteSamlProvider(
      { db: ctx.db, dialect: ctx.dialect },
      auth.tenantId!,
      id,
    );
    invalidateTenantAuth(auth.tenantId!);
    return c.json({ ok: true });
  })
  /**
   * Parse a SAMLResponse against this provider's config WITHOUT creating
   * any session or user — just returns the extracted attributes so an admin
   * can see exactly what their attribute_map should look like.
   */
  .post("/providers/:id/test-assertion", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const id = c.req.param("id");
    if (!id) throw new AppError("VALIDATION", "Provider id required");
    const body = TestAssertionInput.parse(await c.req.json());
    const row = await loadSamlProviderById(
      { db: ctx.db, dialect: ctx.dialect },
      auth.tenantId!,
      id,
    );
    if (!row) throw new AppError("NOT_FOUND", "Provider not found");
    const resolved = await resolveSamlProvider(
      { db: ctx.db, dialect: ctx.dialect, env: ctx.env },
      auth.tenantId!,
      // The tenant slug lookup isn't strictly required for parsing — we
      // pass `row.slug` so the synthesized ACS URL is correct in the
      // audience check (which compares against `spEntityId`, not the ACS).
      row.slug,
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
    const mapped = {
      email: pickMapped(assertion.attributes, row.attributeMap.email ?? "email"),
      firstName: pickMapped(
        assertion.attributes,
        row.attributeMap.firstName ?? "firstName",
      ),
      lastName: pickMapped(
        assertion.attributes,
        row.attributeMap.lastName ?? "lastName",
      ),
      groups: pickMappedAll(
        assertion.attributes,
        row.attributeMap.groups ?? "groups",
      ),
    };
    return c.json({
      data: {
        nameId: assertion.nameId,
        issuer: assertion.issuer,
        audience: assertion.audience,
        authnContext: assertion.authnContext,
        sessionIndex: assertion.sessionIndex,
        notOnOrAfter: assertion.notOnOrAfter,
        attributes: assertion.attributes,
        mapped,
      },
    });
  })
  /**
   * Pre-fill helper: parse an IdP metadata XML document (pasted or fetched
   * from a URL) and return the four fields the create form needs.
   */
  .post("/providers/import-metadata", async (c) => {
    const auth = c.get("auth");
    const ctx = c.get("ctx");
    const body = ImportMetadataInput.parse(await c.req.json());
    let xml = body.metadataXml ?? "";
    if (!xml && body.metadataUrl) {
      const res = await fetch(body.metadataUrl);
      if (!res.ok) {
        throw new AppError(
          "VALIDATION",
          `Metadata fetch returned ${res.status}`,
        );
      }
      xml = await res.text();
    }
    const parsed = parseMetadataXml(xml);
    // spEntityId default = our metadata URL for the eventual provider slug.
    // The admin sees this in the create form and can override.
    const slug = "imported";
    const { metadataUrl } = buildAcsAndMetadataUrls(
      ctx.env,
      // We don't know the tenant slug here — fall back to the workspace id.
      auth.tenantId!,
      slug,
    );
    return c.json({
      data: { ...parsed, spEntityIdSuggested: metadataUrl },
    });
  });

const pickMapped = (
  attrs: Record<string, string[]>,
  key: string,
): string | null => {
  const v = attrs[key];
  if (!v || v.length === 0) return null;
  return v[0] ?? null;
};

const pickMappedAll = (
  attrs: Record<string, string[]>,
  key: string,
): string[] => attrs[key] ?? [];
