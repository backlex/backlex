import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const TAG = "saml-admin";

const AttributeMap = z
  .object({
    email: z.string().min(1).optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    groups: z.string().min(1).optional(),
  })
  .catchall(z.string())
  .openapi("SamlAttributeMap");

const SamlProviderInput = z
  .object({
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(60).optional(),
    idpTemplate: z
      .enum(["okta", "azure", "google", "adfs", "jumpcloud", "auth0"])
      .nullable()
      .optional(),
    entityId: z.string().min(1),
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
  })
  .openapi("SamlProviderInput");

const SamlProviderPatch = SamlProviderInput.partial().openapi("SamlProviderPatch");

const SamlProviderRow = z
  .object({
    id: z.string(),
    tenantId: z.string(),
    name: z.string(),
    slug: z.string(),
    idpTemplate: z.string().nullable(),
    entityId: z.string(),
    ssoUrl: z.string(),
    sloUrl: z.string().nullable(),
    spEntityId: z.string(),
    attributeMap: AttributeMap,
    defaultRoleId: z.string().nullable(),
    groupsToRoles: z.record(z.string(), z.string()).nullable(),
    signatureAlgorithm: z.string(),
    wantSignedAssertions: z.boolean(),
    linkByVerifiedEmail: z.boolean(),
    nameIdFormat: z.string(),
    enabled: z.boolean(),
    hasIdpCert: z.boolean(),
    createdAt: z.unknown().nullable(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("SamlProviderRow");

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/saml/providers",
  tags: [TAG],
  summary: "List SAML providers",
  description: "Sanitized rows for the active workspace; the IdP certificate PEM is never returned.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(SamlProviderRow) }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/saml/providers",
  tags: [TAG],
  summary: "Create SAML provider",
  description: "Stores the cert as encrypted ciphertext. Invalidates the cached tenant-auth instance.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: SamlProviderInput } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: z.object({ data: SamlProviderRow }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/admin/saml/providers/{id}",
  tags: [TAG],
  summary: "Update SAML provider",
  description: "Partial update. Omitted fields keep their stored values.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: { required: true, content: { "application/json": { schema: SamlProviderPatch } } },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: z.object({ data: SamlProviderRow }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/admin/saml/providers/{id}",
  tags: [TAG],
  summary: "Delete SAML provider",
  description: "Removes the provider row. Linked `external_identities` rows are kept.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/saml/providers/{id}/test-assertion",
  tags: [TAG],
  summary: "Test a SAMLResponse",
  description: "Parses the given SAMLResponse against this provider without creating a session.",
  security: SECURITY,
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ samlResponse: z.string().min(1) }).openapi("SamlTestAssertionInput"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Parsed assertion",
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              nameId: z.string().nullable(),
              issuer: z.string().nullable(),
              audience: z.string().nullable(),
              authnContext: z.string().nullable(),
              sessionIndex: z.string().nullable(),
              notOnOrAfter: z.string().nullable(),
              attributes: z.record(z.array(z.string())),
              mapped: z.object({
                email: z.string().nullable(),
                firstName: z.string().nullable(),
                lastName: z.string().nullable(),
                groups: z.array(z.string()),
              }),
            }),
          }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/saml/providers/import-metadata",
  tags: [TAG],
  summary: "Parse IdP metadata XML",
  description: "Fetches/parses an IdP metadata document and returns the four fields the create form needs.",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              metadataXml: z.string().min(1).optional(),
              metadataUrl: z.string().url().optional(),
            })
            .openapi("SamlImportMetadataInput"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              entityId: z.string(),
              ssoUrl: z.string(),
              sloUrl: z.string().nullable(),
              idpCertPem: z.string(),
              spEntityIdSuggested: z.string(),
            }),
          }),
        },
      },
    },
    ...errorResponses,
  },
});
