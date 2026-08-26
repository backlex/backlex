/**
 * Hand-authored OpenAPI metadata for the collections CRUD surface.
 *
 * `routes/collections.ts` is a plain `Hono` app (no `openAPIRegistry`) — its
 * handlers validate with bare zod `.parse()` calls, so `buildStaticDoc` skips
 * the mount entirely and the spec used to omit `/api/collections` altogether.
 * Rather than rewriting the DDL-heavy route file onto `OpenAPIHono`, we follow
 * the sibling-metadata pattern (see `graphql.openapi.ts`): register path items
 * against the shared `apiRegistry`, pulled in by `loadMetadata()`.
 *
 * Schemas here are REPRESENTATIVE, not exhaustive — the real `CollectionInput`
 * has ~40 keys (see `routes/collections.ts`). Key properties are documented;
 * extra properties are accepted. Keep summaries in sync with the route file.
 */
import { FIELD_TYPES } from "@backlex/db";
import { apiRegistry, errorResponses, SECURITY, z } from "../lib/openapi";

const CollectionField = z
  .object({
    name: z.string().openapi({ example: "title" }),
    // Emitted from the canonical list rather than described in prose. The prose
    // it replaces named `datetime`, which is not a field type and is refused by
    // the server (the real one is `timestamp`) — and because the property was a
    // bare `string`, every generated client typed it as `string` instead of the
    // 19-member union, so the wrong word could not be caught until runtime.
    type: z.enum(FIELD_TYPES).openapi({
      description:
        "Field storage type. `divider` and `notice` are presentational — no column, no value.",
      example: "text",
    }),
    required: z.boolean().optional(),
    unique: z.boolean().optional(),
    indexed: z.boolean().optional().openapi({
      description: "Plain B-tree index on the column — speeds up filter / sort.",
    }),
    searchable: z.boolean().optional().openapi({
      description: "Include this field in the collection's full-text index (when `fts` is on).",
    }),
    vectorize: z.boolean().optional().openapi({
      description: "Auto-embed this field on write (when the collection's `vectorize` is on).",
    }),
    to: z.string().optional().openapi({
      description:
        "Target collection slug — required for `relation` / `relation_many`, and refused if no such collection exists.",
      example: "customers",
    }),
    // `hidden` used to be listed here and the server has never accepted it:
    // hiding a field is a `conditions` effect, not a flat property. It was
    // silently dropped on every write until the unknown-key guard landed.
    default: z.unknown().optional(),
  })
  .openapi("CollectionField", {
    description:
      "Field definition. `type` is closed; the other keys shown are the type-independent ones. Per-type options are NESTED under a key named after the concern — `money: { currency | currencyField }`, `phone: { region | regionField }`, `slug: { from: [...] }`, `rollup`, `range`, `sequence`, `geo`, `transitions`, `validation`, `conditions`, `format`. Writing one of those flat (e.g. `region` beside `type: \"phone\"`) is refused with the nested shape in the message, rather than being ignored.",
  });

const Collection = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    slug: z.string().openapi({ example: "articles" }),
    singular: z.string().nullable(),
    plural: z.string().nullable(),
    note: z.string().nullable(),
    fields: z.array(CollectionField),
    ownerScoped: z.boolean(),
    tenantScoped: z.boolean(),
    versioned: z.boolean(),
    softDelete: z.boolean(),
    singleton: z.boolean(),
    auditReads: z.boolean(),
    vectorize: z.boolean(),
    fts: z.boolean(),
    status: z.enum(["active", "inactive", "archived"]),
    physicalTable: z.string().openapi({ example: "c_ab12cd34ef56_articles" }),
    adopted: z.boolean().openapi({
      description: "True when backlex only wraps a pre-existing physical table (no DDL).",
    }),
    pkColumn: z.string().nullable(),
    group: z.string().nullable(),
    sortOrder: z.number().int().nullable(),
  })
  .openapi("Collection", {
    description:
      "Collection metadata row (representative shape — presentational keys like `icon`, `color`, `hidden`, `previewUrl`, Kanban settings etc. are also present).",
  });

const CollectionCreate = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .openapi({ example: "articles" }),
    fields: z.array(CollectionField),
    singular: z.string().nullable().optional(),
    plural: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    ownerScoped: z.boolean().optional().openapi({ description: "Rows are owned by their creator." }),
    tenantScoped: z.boolean().optional().openapi({
      description: "Default true — the physical table gets a `tenant_id` column.",
    }),
    versioned: z.boolean().optional().openapi({ description: "Enable draft/publish lifecycle." }),
    softDelete: z.boolean().optional(),
    singleton: z.boolean().optional(),
    auditReads: z.boolean().optional(),
    vectorize: z.boolean().optional(),
    fts: z.boolean().optional(),
    physicalTable: z.string().optional().openapi({
      description:
        "Physical table name. Optional for managed creates (defaults to `c_<tenantPrefix>_<slug>`); required when `adopted: true`.",
    }),
    adopted: z.boolean().optional().openapi({
      description:
        "Default false (managed create — backlex runs DDL). When true, registers an EXISTING table without DDL; field names and PK are validated against the live table shape (introspect via `POST /api/admin/adopt/inspect` first).",
    }),
    pkColumn: z.string().optional().openapi({
      description: "Adopted-only: must match the introspected primary key.",
    }),
    pkType: z.enum(["uuid", "text", "integer"]).optional(),
    hasCreatedAt: z.boolean().optional(),
    hasUpdatedAt: z.boolean().optional(),
    createdAtColumn: z.string().nullable().optional(),
    updatedAtColumn: z.string().nullable().optional(),
    ownerIdColumn: z.string().nullable().optional(),
  })
  .openapi("CollectionCreate", {
    description:
      "Create payload (representative — the full input also accepts presentational and search/vector options).",
  });

const CollectionPatch = CollectionCreate.partial()
  .extend({
    status: z.enum(["active", "inactive"]).optional().openapi({
      description:
        "`inactive` keeps the collection editable in the admin but 404s all item traffic. `archived` is not patchable — archiving goes through DELETE.",
    }),
  })
  .openapi("CollectionPatch");

const tags = ["collections"];

apiRegistry.registerPath({
  method: "get",
  path: "/api/collections",
  tags,
  summary: "List collections",
  description:
    "Lists the collections the caller can read (admin sees all; others are filtered by permission grants). Sends a schema ETag — conditional requests may return 304.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(Collection),
            meta: z.object({
              groups: z
                .array(z.string())
                .openapi({ description: "Ordered group-header names for the admin sidebar." }),
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
  path: "/api/collections",
  tags,
  summary: "Create or adopt a collection",
  description:
    "Admin-only, DDL-gated. The single create endpoint: with `adopted: false` (default) backlex creates the physical table; with `adopted: true` it only writes the metadata row wrapping an existing table.",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CollectionCreate } },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: {
        "application/json": { schema: z.object({ data: Collection }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/collections/{slug}",
  tags,
  summary: "Get collection",
  description:
    "Fetches one collection's metadata. 404 when it doesn't exist, is archived (unless `include_archived=true`), or the caller has no read grant.",
  security: SECURITY,
  request: {
    params: z.object({ slug: z.string() }),
    query: z.object({
      include_archived: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: Collection }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "patch",
  path: "/api/collections/{slug}",
  tags,
  summary: "Update collection",
  description:
    "Admin-only, DDL-gated. Partial update — schema changes are ADDITIVE only (new fields create columns; removing a field from `fields` does not drop its column — use the dropField endpoint).",
  security: SECURITY,
  request: {
    params: z.object({ slug: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: CollectionPatch } },
    },
  },
  responses: {
    200: {
      description: "Updated",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            slug: z.string().openapi({ description: "Post-update slug (renames are allowed)." }),
            renamed: z.unknown().optional(),
            ftsBackfill: z.unknown().optional(),
          }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/collections/{slug}",
  tags,
  summary: "Delete (or archive) collection",
  description:
    "Admin-only, DDL-gated. Managed collections are deleted along with their physical table; adopted collections are archived — the metadata row is kept and the underlying table is never touched.",
  security: SECURITY,
  request: { params: z.object({ slug: z.string() }) },
  responses: {
    200: {
      description: "Deleted (managed) or archived (adopted).",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            archived: z
              .boolean()
              .openapi({ description: "True when the collection was adopted and only archived." }),
          }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "delete",
  path: "/api/collections/{slug}/fields/{name}",
  tags,
  summary: "Drop field",
  description:
    "Admin-only, DDL-gated. The explicit destructive path: removes the field from metadata AND drops the physical column (managed tables). Kept separate from PATCH so admins audit destructive moves.",
  security: SECURITY,
  request: { params: z.object({ slug: z.string(), name: z.string() }) },
  responses: {
    200: {
      description: "Dropped",
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), slug: z.string(), field: z.string() }),
        },
      },
    },
    ...errorResponses,
  },
});
