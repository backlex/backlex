import { and, eq, inArray } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { PgDb } from "@backlex/db/pg";
import type { SqliteDb } from "@backlex/db/sqlite";
import type { SMSAdapter, SMSSendResult } from "@backlex/core/adapters";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.phoneNumbers : sqlite.schema.phoneNumbers;

export interface SmsDispatch {
  /** Recipients. SMS only ever goes to known, registered numbers — never a
   *  blind broadcast — so the caller resolves a user set first. */
  userIds: string[];
  body: string;
  from?: string;
}

interface DbCtx {
  db: PgDb | SqliteDb;
  dialect: "pg" | "sqlite";
  smsFor: (tenantId: string | null | undefined) => Promise<SMSAdapter>;
}

/**
 * Send an SMS to a set of users' active phone numbers for one workspace. Loads
 * the recipients' `phone_numbers`, resolves the workspace SMS transport, sends,
 * and deactivates any numbers the provider reported as permanently invalid (so
 * the next send skips them). Returns `{ sent, failed, invalidNumbers }`; a
 * recipient set with no registered numbers is a no-op.
 */
export const sendSmsToUsers = async (
  ctx: DbCtx,
  tenantId: string | null | undefined,
  dispatch: SmsDispatch,
): Promise<SMSSendResult> => {
  if (dispatch.userIds.length === 0) return { sent: 0, failed: 0, invalidNumbers: [] };
  const t = tableFor(ctx.dialect);

  const where =
    tenantId == null
      ? and(inArray(t.userId, dispatch.userIds), eq(t.isActive, true))
      : and(
          inArray(t.userId, dispatch.userIds),
          eq(t.isActive, true),
          eq(t.tenantId, tenantId),
        );
  const rows = (await (ctx.db as any).select().from(t).where(where)) as {
    phoneNumber: string;
  }[];
  if (rows.length === 0) return { sent: 0, failed: 0, invalidNumbers: [] };

  // De-dupe — a user could have registered the same number twice across rows.
  const numbers = [...new Set(rows.map((r) => r.phoneNumber))];

  const adapter = await ctx.smsFor(tenantId ?? null);
  const result = await adapter.send({ to: numbers, body: dispatch.body, from: dispatch.from });

  // Deactivate numbers the provider rejected as gone — keep the row (a
  // re-register revives it via the unique index) but stop targeting it.
  if (result.invalidNumbers.length > 0) {
    try {
      await (ctx.db as any)
        .update(t)
        .set({ isActive: false })
        .where(inArray(t.phoneNumber, result.invalidNumbers));
    } catch {
      // best-effort cleanup; never fail the send over pruning
    }
  }
  return result;
};

/**
 * Send an SMS to raw E.164 numbers for one workspace — no `phone_numbers`
 * lookup, and so no pruning either (there is no row to deactivate).
 *
 * This is the path for recipients who are *not* platform users: an appointment
 * reminder goes to the customer whose number lives on the booking row. Callers
 * must have resolved and validated the numbers themselves; `sendSmsToUsers`
 * stays the right entry point whenever the recipient is a registered user.
 */
export const sendSmsToNumbers = async (
  ctx: Pick<DbCtx, "smsFor">,
  tenantId: string | null | undefined,
  dispatch: { numbers: string[]; body: string; from?: string },
): Promise<SMSSendResult> => {
  const numbers = [...new Set(dispatch.numbers)];
  if (numbers.length === 0) return { sent: 0, failed: 0, invalidNumbers: [] };
  const adapter = await ctx.smsFor(tenantId ?? null);
  return adapter.send({ to: numbers, body: dispatch.body, from: dispatch.from });
};
