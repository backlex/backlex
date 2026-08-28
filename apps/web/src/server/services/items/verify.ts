import { sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import { verifySecret } from "@backlex/auth/secret-hash";
import type { Ctx } from "../../context";
import { rateLimitOk } from "../../lib/rate-limit";
import { recordActivity } from "../activity";
import type { CollectionRow } from "./collection-loader";
import type { ResolvedPerm } from "./write";
import {
  deletedFilter,
  fromOf,
  pkEq,
  queryAll,
  tenantFilter,
  whereOf,
} from "./sql-helpers";

/**
 * Shared verification core for `hash` fields. Every surface (REST, GraphQL,
 * MCP, CLI) calls THIS — the rate-limit + read-permission + audit guards live
 * here once so no twin can accidentally drop them (a verify endpoint without a
 * throttle is a brute-force oracle).
 */

/** Attempts allowed per (tenant, collection, item, field) window. */
export const VERIFY_RATE_MAX = 10;
export const VERIFY_RATE_WINDOW_MS = 60_000;

export interface VerifyAuth {
  userId: string | null;
  tenantId: string | null | undefined;
  roles: string[];
}

/**
 * Return whether `value` matches the stored digest of `field` on item `id`.
 *
 *  - the field must exist and be a `hash` field (else 422),
 *  - the caller's read permission (rows via `perm.whereSql`, field via
 *    `perm.fields`) and tenant scope gate which row/field can be probed,
 *  - throttled per (tenant, collection, item, field) so guessing one secret is
 *    slow regardless of the caller's IP,
 *  - the attempt is audit-logged (field name + boolean result only — never the
 *    plaintext or the digest).
 */
export const verifyHashField = async (
  ctx: Ctx,
  collection: CollectionRow,
  auth: VerifyAuth,
  perm: ResolvedPerm,
  id: string,
  field: string,
  value: unknown,
  meta?: Record<string, unknown>,
): Promise<boolean> => {
  const def = collection.fields.find((f) => f.name === field);
  if (!def || def.type !== "hash") {
    throw new AppError("VALIDATION", `Field "${field}" is not a hash field`);
  }
  if (perm.fields && !perm.fields.has(field)) {
    throw new AppError("FORBIDDEN", `No permission to read field "${field}"`);
  }
  if (typeof value !== "string" || value === "") {
    throw new AppError("VALIDATION", "`value` must be a non-empty string");
  }

  const rlKey = `hash-verify:${auth.tenantId ?? "-"}:${collection.slug}:${id}:${field}`;
  if (!(await rateLimitOk(ctx.env, rlKey, VERIFY_RATE_MAX, VERIFY_RATE_WINDOW_MS))) {
    throw new AppError(
      "RATE_LIMITED",
      "Too many verification attempts — try again shortly",
    );
  }

  const tenantWhere = tenantFilter(collection, {
    tenantId: auth.tenantId ?? null,
    roles: auth.roles,
  });
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${sql.identifier(field)} AS ${sql.identifier("__hash")}
        FROM ${fromOf(collection)}
        ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere, deletedFilter(collection))}
        LIMIT 1`,
  );
  if (!rows[0]) throw new AppError("NOT_FOUND", "Item not found");
  const stored = rows[0].__hash;
  const valid = typeof stored === "string" ? await verifySecret(value, stored) : false;

  await recordActivity(
    { db: ctx.db, dialect: ctx.dialect },
    {
      userId: auth.userId,
      tenantId: auth.tenantId ?? null,
      action: "verify",
      collection: collection.slug,
      itemId: id,
      ...(meta ?? {}),
      payload: { field },
      response: { valid },
    },
  );
  return valid;
};
