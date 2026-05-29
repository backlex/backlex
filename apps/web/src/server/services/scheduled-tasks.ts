import { sql, and, eq, isNull, lte } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AuthSubject, Operation } from "@backlex/core";
import type { Ctx } from "../context";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.scheduledTasks : sqlite.schema.scheduledTasks;

/** Body of a queued continuation. The scheduler claims the row, parses
 *  this payload, and resumes by running `remainingOps` with the captured
 *  state. */
export interface ResumePayload {
  kind: "flow-continuation";
  flowName?: string;
  remainingOps: Operation[];
  data: Record<string, unknown>;
  authSubject: AuthSubject;
  last: unknown;
}

export interface EnqueueInput {
  flowId?: string | null;
  tenantId?: string | null;
  runAt: Date;
  payload: ResumePayload;
}

const nowFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? new Date() : Date.now();

const tsValue = (date: Date, dialect: "pg" | "sqlite"): unknown =>
  dialect === "pg" ? date : date.getTime();

export const enqueueTask = async (
  ctx: Ctx,
  input: EnqueueInput,
): Promise<{ id: string }> => {
  const t = tableFor(ctx.dialect);
  const id = crypto.randomUUID();
  await (ctx.db as any).insert(t).values({
    id,
    tenantId: input.tenantId ?? null,
    flowId: input.flowId ?? null,
    payload: input.payload,
    runAt: tsValue(input.runAt, ctx.dialect),
    claimedAt: null,
    createdAt: nowFor(ctx.dialect),
  });
  return { id };
};

interface PendingRow {
  id: string;
  tenantId: string | null;
  flowId: string | null;
  payload: ResumePayload;
  runAt: Date | number;
}

/**
 * Atomically claim due rows and return them. Each row in the result has
 * already been marked `claimed_at = now` so concurrent ticks won't
 * re-claim. The caller is responsible for deleting on success or
 * resetting `claimed_at` to retry.
 *
 * On Postgres this is a single `UPDATE ... RETURNING *` — race-free.
 * On SQLite (Bun) we issue an UPDATE with a synthesized `claimed_at` and
 * then read back the rows we touched; the race window is bounded by the
 * scheduler's own serialized tick (one process, one timer).
 */
export const claimDueTasks = async (
  ctx: Ctx,
): Promise<PendingRow[]> => {
  const t = tableFor(ctx.dialect);
  const now = nowFor(ctx.dialect);

  if (ctx.dialect === "pg") {
    const tableName = sql.identifier("scheduled_tasks");
    const result = await (ctx.db as any).execute(
      sql`
        UPDATE ${tableName}
        SET ${sql.identifier("claimed_at")} = ${now}
        WHERE ${sql.identifier("claimed_at")} IS NULL
          AND ${sql.identifier("run_at")} <= ${now}
        RETURNING ${sql.identifier("id")},
                  ${sql.identifier("tenant_id")} AS "tenantId",
                  ${sql.identifier("flow_id")} AS "flowId",
                  ${sql.identifier("payload")},
                  ${sql.identifier("run_at")} AS "runAt"
      `,
    );
    const rows = Array.isArray(result)
      ? result
      : (result?.rows ?? []);
    return rows as PendingRow[];
  }

  // SQLite: select ids first, mark them, then return parsed payloads.
  const candidates = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(isNull(t.claimedAt), lte(t.runAt, now as number)))) as Array<{
      id: string;
      tenantId: string | null;
      flowId: string | null;
      payload: ResumePayload | string;
      runAt: number;
    }>;
  if (candidates.length === 0) return [];

  for (const row of candidates) {
    await (ctx.db as any)
      .update(t)
      .set({ claimedAt: now })
      .where(and(eq(t.id, row.id), isNull(t.claimedAt)));
  }

  return candidates.map((r) => ({
    id: r.id,
    tenantId: r.tenantId,
    flowId: r.flowId,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    runAt: r.runAt,
  }));
};

/** Remove a successfully resumed task. Errors are logged by the caller. */
export const deleteTask = async (
  ctx: Ctx,
  id: string,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  await (ctx.db as any).delete(t).where(eq(t.id, id));
};
