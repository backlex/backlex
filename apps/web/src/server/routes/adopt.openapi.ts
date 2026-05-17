import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, errorResponses } from "../lib/openapi";

const TAG = "adopt";

const SLUG_RE = /^[a-z][a-z0-9_]*$/;

const FieldInput = z
  .object({
    name: z.string().min(1).regex(SLUG_RE),
    type: z.enum([
      "text",
      "longtext",
      "integer",
      "number",
      "boolean",
      "json",
      "timestamp",
      "uuid",
      "relation",
    ]),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    to: z.string().regex(SLUG_RE).optional(),
    interface: z.string().min(1).max(64).optional(),
  })
  .openapi("AdoptFieldInput");

const ApplyInput = z
  .object({
    table: z.string().min(1).max(120),
    slug: z.string().min(1).max(60).regex(SLUG_RE),
    singular: z.string().optional(),
    plural: z.string().optional(),
    note: z.string().optional(),
    pkColumn: z.string().min(1).max(120),
    ownerScoped: z.boolean().optional(),
    tenantScoped: z.boolean().optional(),
    addCreatedAt: z.boolean().optional(),
    addUpdatedAt: z.boolean().optional(),
    defaultSort: z.string().nullable().optional(),
    fields: z.array(FieldInput),
  })
  .openapi("AdoptApplyInput");

const AdoptableTable = z
  .object({
    name: z.string(),
    rowCount: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough()
  .openapi("AdoptableTable");

const InspectColumn = z
  .object({
    name: z.string(),
    type: z.string(),
    nullable: z.boolean(),
    default: z.unknown().nullable().optional(),
  })
  .passthrough();

const InspectResult = z
  .object({
    table: z.string(),
    columns: z.array(InspectColumn),
    pk: z.object({ column: z.string() }).nullable(),
    systemColumnsPresent: z.object({
      createdAt: z.boolean(),
      updatedAt: z.boolean(),
    }),
  })
  .passthrough()
  .openapi("AdoptInspectResult");

const AdoptedCollection = z
  .object({
    id: z.string(),
    slug: z.string(),
    tenantId: z.string(),
    physicalTable: z.string(),
    singular: z.string().nullable(),
    plural: z.string().nullable(),
    note: z.string().nullable(),
    fields: z.array(FieldInput),
    ownerScoped: z.boolean(),
    tenantScoped: z.boolean(),
    versioned: z.boolean(),
    vectorize: z.boolean(),
    defaultSort: z.string().nullable(),
    adopted: z.literal(true),
    pkColumn: z.string(),
    hasCreatedAt: z.boolean(),
    hasUpdatedAt: z.boolean(),
  })
  .openapi("AdoptedCollection");

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/adopt/tables",
  tags: [TAG],
  summary: "List adoptable tables",
  description: "Physical tables not already adopted by this workspace and not a managed `c_*` or system table.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(AdoptableTable) }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/adopt/inspect",
  tags: [TAG],
  summary: "Introspect a table",
  description: "Returns columns + PK + which system columns happen to be present. No DDL.",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ table: z.string().min(1).max(120) }).openapi("AdoptInspectInput"),
        },
      },
    },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: InspectResult }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/adopt/apply",
  tags: [TAG],
  summary: "Adopt a table",
  description: "Writes the `collections` metadata row with `adopted=true`. Never runs DDL against the user's table.",
  security: SECURITY,
  request: { body: { required: true, content: { "application/json": { schema: ApplyInput } } } },
  responses: {
    201: { description: "Adopted", content: { "application/json": { schema: z.object({ data: AdoptedCollection }) } } },
    ...errorResponses,
  },
});
