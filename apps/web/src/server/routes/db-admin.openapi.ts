import { z } from "../lib/openapi";
import { apiRegistry, SECURITY, errorResponses } from "../lib/openapi";

const TAG = "db-admin";

const SqlRunInput = z
  .object({ sql: z.string().min(1).max(10000) })
  .openapi("SqlRunInput");

const SqlStatementResult = z.object({
  rows: z.array(z.record(z.unknown())),
  ms: z.number().int().nonnegative(),
});

const TableCount = z.object({
  name: z.string(),
  rows: z.number().int().nonnegative(),
});

const MigrationRow = z
  .object({
    id: z.union([z.string(), z.number()]),
    hash: z.string(),
    created_at: z.union([z.string(), z.number()]),
    tag: z.string().nullable(),
    applied: z.boolean(),
  })
  .openapi("MigrationRow");

const BackupRow = z
  .object({
    id: z.string(),
    tenantId: z.string().nullable(),
    kind: z.string(),
    label: z.string().nullable(),
    storageKey: z.string(),
    size: z.number().int().nonnegative(),
    tableCount: z.number().int().nonnegative(),
    status: z.string(),
    createdBy: z.string().nullable(),
    createdAt: z.unknown().nullable(),
  })
  .openapi("BackupRow");

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/db/sql/run",
  tags: [TAG],
  summary: "Run SQL",
  description:
    "Read-only by default. Writes require `?writes=1` AND `X-Workeros-Confirm: yes` header. Splits on `;` and runs each statement.",
  security: SECURITY,
  request: {
    query: z.object({ writes: z.enum(["0", "1"]).optional() }),
    body: { required: true, content: { "application/json": { schema: SqlRunInput } } },
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(SqlStatementResult),
            ms: z.number().int(),
            count: z.number().int(),
          }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/db/tables",
  tags: [TAG],
  summary: "List user-visible tables",
  description: "Tables with row counts. Drops the drizzle migrations table and runtime system tables.",
  security: SECURITY,
  request: { query: z.object({ limit: z.string().optional() }) },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(TableCount) }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/db/migrations",
  tags: [TAG],
  summary: "List applied migrations",
  description: "Joins the drizzle migrations table with the build-time manifest for human-readable tags.",
  security: SECURITY,
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ data: z.array(MigrationRow), note: z.string().optional() }),
        },
      },
    },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/db/backups",
  tags: [TAG],
  summary: "List backups",
  description: "Backup tracking rows for the active workspace, newest first.",
  security: SECURITY,
  responses: {
    200: { description: "OK", content: { "application/json": { schema: z.object({ data: z.array(BackupRow) }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "post",
  path: "/api/admin/db/backups/now",
  tags: [TAG],
  summary: "Run a manual backup",
  description: "Inserts the tracking row and runs the dump synchronously. Returns the refreshed row.",
  security: SECURITY,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ label: z.string().max(80).optional() }).openapi("BackupNowInput"),
        },
      },
    },
  },
  responses: {
    201: { description: "Done", content: { "application/json": { schema: z.object({ data: BackupRow }) } } },
    ...errorResponses,
  },
});

apiRegistry.registerPath({
  method: "get",
  path: "/api/admin/db/backups/{id}/download",
  tags: [TAG],
  summary: "Download a backup",
  description: "Streams the JSONL dump from the storage adapter.",
  security: SECURITY,
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Backup file",
      content: { "application/x-ndjson": { schema: z.string() } },
    },
    ...errorResponses,
  },
});
