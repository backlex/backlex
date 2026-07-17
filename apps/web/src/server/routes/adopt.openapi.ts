/**
 * Hand-authored OpenAPI metadata for the collection-adoption helper endpoints.
 *
 * `routes/adopt.ts` is a plain `Hono` app (no `openAPIRegistry`), so
 * `buildStaticDoc` skips its mount — these path items document it via the
 * shared `apiRegistry` instead (same pattern as `collections.openapi.ts`).
 * The actual adopt WRITE is `POST /api/collections` with `adopted: true`;
 * these are the discovery + introspection reads the admin wizard runs first.
 * Keep shapes in sync with `services/adopt.ts`.
 */
import { apiRegistry, errorResponses, SECURITY, z } from "../lib/openapi";

const AdoptableTable = z
  .object({
    name: z.string().openapi({ example: "legacy_orders" }),
    columns: z.number().int(),
    rowCount: z.number().int(),
    disabled: z.string().nullable().openapi({
      description: "Non-null = shown but not adoptable, with the reason.",
    }),
  })
  .openapi("AdoptableTable");

const InspectedTable = z
  .object({
    table: z.string(),
    pk: z
      .object({
        column: z.string(),
        dbType: z.string(),
        supported: z.boolean(),
      })
      .nullable(),
    columns: z.array(
      z.object({
        name: z.string(),
        dbType: z.string(),
        nullable: z.boolean(),
        isPk: z.boolean(),
        suggested: z.string().nullable().openapi({
          description: "Suggested backlex field type for this column, or null.",
        }),
        reserved: z.string().optional().openapi({
          description: "Set when the column name collides with a reserved/system name.",
        }),
      }),
    ),
    systemColumnsPresent: z.object({
      createdAt: z.boolean(),
      updatedAt: z.boolean(),
      ownerId: z.boolean(),
    }),
    aliasSuggestions: z.object({
      createdAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
      ownerId: z.string().nullable(),
    }),
    foreignKeys: z.array(
      z.object({
        column: z.string(),
        referencesTable: z.string(),
        referencesColumn: z.string(),
        composite: z.boolean(),
        targetCollection: z
          .object({ slug: z.string(), id: z.string() })
          .optional()
          .openapi({
            description:
              "Present when the parent table matches an existing collection in the workspace.",
          }),
      }),
    ),
    warnings: z.array(z.string()),
  })
  .openapi("InspectedTable");

const tags = ["collections"];

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/adopt/tables",
  tags,
  summary: "List adopt-eligible tables",
  description:
    "Admin-only. Lists every physical table in the active database that can be adopted — excludes managed `c_*` tables, backlex system tables, and tables this workspace already adopted.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: z.array(AdoptableTable) }) },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/adopt/inspect",
  tags,
  summary: "Inspect a physical table",
  description:
    "Admin-only. Introspects one table (columns, PK, FKs, which conventional system columns already exist) so the wizard can build the `POST /api/collections` adopt payload. Read-only — never alters the table.",
  security: SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ table: z.string().min(1).max(120) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ data: InspectedTable }) },
      },
    },
    ...errorResponses,
  },
});
