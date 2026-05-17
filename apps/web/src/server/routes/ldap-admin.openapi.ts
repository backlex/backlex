import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, OkSchema, errorResponses } from "../lib/openapi";

const TAG = "ldap-admin";

const AttributeMapInput = z
  .object({
    email: z.string().min(1).optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    groups: z.string().min(1).optional(),
  })
  .partial()
  .catchall(z.string())
  .openapi("LdapAttributeMap");

const LdapPutInput = z
  .object({
    enabled: z.boolean().optional(),
    url: z.string().min(1).optional(),
    bindDn: z.string().min(1).optional(),
    baseDn: z.string().min(1).optional(),
    userFilter: z.string().min(1).optional(),
    groupFilter: z.union([z.string(), z.literal(""), z.null()]).optional(),
    attributeMap: AttributeMapInput.optional(),
    defaultRoleId: z.union([z.string().min(1), z.null()]).optional(),
    groupsToRoles: z.record(z.string(), z.string()).nullable().optional(),
    tlsOptions: z.object({ rejectUnauthorized: z.boolean().optional() }).nullable().optional(),
    domainMatch: z.array(z.string().min(1)).nullable().optional(),
    rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
    secrets: z
      .object({
        bindPassword: z.union([z.string(), z.null()]).optional(),
        caPem: z.union([z.string(), z.null()]).optional(),
      })
      .optional(),
  })
  .openapi("LdapPutInput");

const LdapConfigRow = z
  .object({
    tenantId: z.string(),
    enabled: z.boolean(),
    url: z.string(),
    bindDn: z.string(),
    baseDn: z.string(),
    userFilter: z.string(),
    groupFilter: z.string().nullable(),
    attributeMap: AttributeMapInput,
    defaultRoleId: z.string().nullable(),
    groupsToRoles: z.record(z.string(), z.string()).nullable(),
    tlsOptions: z.object({ rejectUnauthorized: z.boolean().optional() }).nullable(),
    secretsSet: z.object({ bindPassword: z.boolean(), caPem: z.boolean() }),
    domainMatch: z.array(z.string()).nullable(),
    rateLimitPerMinute: z.number().int(),
    updatedAt: z.unknown().nullable(),
  })
  .openapi("LdapConfigRow");

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/ldap-config",
  tags: [TAG],
  summary: "Get LDAP config",
  description: "Sanitized — ciphertext secrets are exposed only as boolean `secretsSet` flags.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: LdapConfigRow }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "put",
  path: "/api/admin/ldap-config",
  tags: [TAG],
  summary: "Upsert LDAP config",
  description:
    "Encrypts `bindPassword` / `caPem` before storing. Omitted secret keys keep their existing ciphertext; `\"\"` or `null` clears.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: LdapPutInput } } } },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: OkSchema } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/ldap-config/test",
  tags: [TAG],
  summary: "Test LDAP bind",
  description: "Service-bind + user-bind round-trip. Does NOT create an `app_users` row or session.",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z
            .object({
              username: z.string().min(1).max(320),
              password: z.string().min(1).max(1024),
            })
            .openapi("LdapTestInput"),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Result — `ok:false` for any auth/transport failure (still 200).",
      content: {
        "application/json": {
          schema: z.union([
            z.object({ ok: z.literal(false), reason: z.string() }),
            z.object({
              ok: z.literal(true),
              dn: z.string(),
              attributes: z.object({
                email: z.string().nullable(),
                firstName: z.string().nullable(),
                lastName: z.string().nullable(),
                groups: z.array(z.string()),
              }),
            }),
          ]),
        },
      },
    },
    ...errorResponses,
  },
});
