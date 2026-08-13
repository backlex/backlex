import { AppError, SYSTEM_ROLES } from "@backlex/core";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLID,
  GraphQLInt,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { JSONScalar, type GqlCtx } from "./core";
import {
  listBackups,
  startManualBackup,
  restoreBackupById,
  loadBackupConfig,
  saveBackupConfig,
  type BackupConfig,
} from "../backup";

// ── Backup / restore ─────────────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/admin/db/backups*` + MCP
// `backups.*` + SDK `client.backups.*`. Reuses the service helpers so tenant
// scoping and the tracking-row lifecycle live in one place. Like dashboards,
// backups don't vary with collection schema, so the fields merge into every
// schema.

/** Mirrors REST `requireAdmin` on `/api/admin/db` — admin role required, but a
 *  missing active tenant is allowed (backups then run in the global scope). */
const requireBackupAdmin = (gqlCtx: GqlCtx): string | null => {
  if (!gqlCtx.auth.roles.includes(SYSTEM_ROLES.admin))
    throw new GraphQLError("Admin role required", { extensions: { code: "FORBIDDEN" } });
  return gqlCtx.auth.tenantId ?? null;
};

/** yoga masks non-GraphQLError throws as "Unexpected error." — re-throw the
 *  service's AppErrors as GraphQLErrors so scoping errors survive, code kept. */
const surfacing = async <T>(work: () => Promise<T> | T): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

const BackupType = new GraphQLObjectType({
  name: "Backup",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    tenantId: { type: GraphQLString },
    kind: { type: new GraphQLNonNull(GraphQLString) },
    label: { type: GraphQLString },
    storageKey: { type: new GraphQLNonNull(GraphQLString) },
    // Float, not Int — a dump can exceed the 32-bit byte range.
    size: { type: new GraphQLNonNull(GraphQLFloat) },
    tableCount: { type: new GraphQLNonNull(GraphQLInt) },
    status: { type: new GraphQLNonNull(GraphQLString) },
    createdBy: { type: GraphQLString },
    createdAt: { type: JSONScalar },
  },
});

const BackupConfigType = new GraphQLObjectType({
  name: "BackupConfig",
  fields: {
    schedule: { type: new GraphQLNonNull(GraphQLString) },
    retain: { type: new GraphQLNonNull(GraphQLInt) },
    retainDays: { type: GraphQLInt },
  },
});

const BackupConfigInputType = new GraphQLInputObjectType({
  name: "BackupConfigInput",
  fields: {
    schedule: { type: GraphQLString },
    retain: { type: GraphQLInt },
    retainDays: { type: GraphQLInt },
  },
});

const RestoreResultType = new GraphQLObjectType({
  name: "RestoreResult",
  fields: {
    tableCount: { type: new GraphQLNonNull(GraphQLInt) },
    rowCount: { type: new GraphQLNonNull(GraphQLInt) },
    skipped: { type: new GraphQLNonNull(GraphQLInt) },
    overwritten: { type: new GraphQLNonNull(GraphQLInt) },
    keptAdditive: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
    },
  },
});

export const backupQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  backups: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(BackupType))),
    description:
      "Backup tracking rows for the active workspace, newest first (admin-only).",
    resolve: (_src, _args, gqlCtx) => {
      const tenantId = requireBackupAdmin(gqlCtx);
      return surfacing(() => listBackups(gqlCtx.ctx, tenantId));
    },
  },
  backupConfig: {
    type: new GraphQLNonNull(BackupConfigType),
    description:
      "The workspace's automatic-backup schedule + retention count (admin-only).",
    resolve: (_src, _args, gqlCtx) => {
      const tenantId = requireBackupAdmin(gqlCtx);
      return surfacing(() => loadBackupConfig(gqlCtx.ctx, tenantId));
    },
  },
};

export const backupMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  runBackup: {
    type: new GraphQLNonNull(BackupType),
    description:
      "Run a manual backup now; returns the refreshed tracking row (admin-only).",
    args: { label: { type: GraphQLString } },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireBackupAdmin(gqlCtx);
      const label = (args as { label?: string | null }).label ?? null;
      if (label != null && label.length > 80)
        throw new GraphQLError("label must be at most 80 characters", {
          extensions: { code: "VALIDATION" },
        });
      return surfacing(() =>
        startManualBackup(gqlCtx.ctx, {
          tenantId,
          userId: gqlCtx.auth.userId ?? null,
          label,
        }),
      );
    },
  },
  restoreBackup: {
    type: new GraphQLNonNull(RestoreResultType),
    description:
      "Restore a backup. Defaults to additive (ON CONFLICT DO NOTHING — never " +
      "overwrites); `overwrite: true` restates rows that still exist to their " +
      "backup-era values, which is what undoes a bad write and is also the only " +
      "mode that can destroy current data. `onlyTables` narrows the restore. " +
      "Requires confirm: true, mirroring REST's X-Backlex-Confirm header (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      confirm: { type: new GraphQLNonNull(GraphQLBoolean) },
      overwrite: { type: GraphQLBoolean },
      onlyTables: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireBackupAdmin(gqlCtx);
      const a = args as {
        id: string;
        confirm: boolean;
        overwrite?: boolean | null;
        onlyTables?: string[] | null;
      };
      if (a.confirm !== true)
        throw new GraphQLError("Restore requires confirm: true.", {
          extensions: { code: "FORBIDDEN" },
        });
      return surfacing(() =>
        restoreBackupById(gqlCtx.ctx, tenantId, a.id, {
          mode: a.overwrite === true ? "overwrite" : "additive",
          onlyTables: a.onlyTables ?? undefined,
          userId: gqlCtx.auth.userId ?? null,
        }),
      );
    },
  },
  setBackupConfig: {
    type: new GraphQLNonNull(BackupConfigType),
    description:
      "Set the automatic-backup schedule (`off` | `daily` | `weekly`) and/or " +
      "retention count 1–365 (admin-only).",
    args: { data: { type: new GraphQLNonNull(BackupConfigInputType) } },
    resolve: (_src, args, gqlCtx) => {
      const tenantId = requireBackupAdmin(gqlCtx);
      const data = (
        args as {
          data: { schedule?: string | null; retain?: number | null; retainDays?: number | null };
        }
      ).data;
      const patch: Partial<BackupConfig> = {};
      if (data.schedule != null) {
        if (!["off", "daily", "weekly"].includes(data.schedule))
          throw new GraphQLError("schedule must be off | daily | weekly", {
            extensions: { code: "VALIDATION" },
          });
        patch.schedule = data.schedule as BackupConfig["schedule"];
      }
      if (data.retain != null) {
        if (!Number.isInteger(data.retain) || data.retain < 1 || data.retain > 365)
          throw new GraphQLError("retain must be an integer between 1 and 365", {
            extensions: { code: "VALIDATION" },
          });
        patch.retain = data.retain;
      }
      // Explicit `retainDays: null` disables the age rule; absent leaves it be.
      if (data.retainDays !== undefined) {
        if (
          data.retainDays !== null &&
          (!Number.isInteger(data.retainDays) || data.retainDays < 1 || data.retainDays > 3650)
        )
          throw new GraphQLError(
            "retainDays must be null or an integer between 1 and 3650",
            { extensions: { code: "VALIDATION" } },
          );
        patch.retainDays = data.retainDays;
      }
      return surfacing(() => saveBackupConfig(gqlCtx.ctx, tenantId, patch));
    },
  },
};
