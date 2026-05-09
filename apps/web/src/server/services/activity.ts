import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import type { DbCtx } from "./seed";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.activity : sqlite.schema.activity;

export interface ActivityInput {
  userId: string | null;
  action: string;
  collection: string;
  itemId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  payload?: unknown;
}

export const recordActivity = async (
  ctx: DbCtx,
  input: ActivityInput,
): Promise<void> => {
  const t = tableFor(ctx.dialect);
  try {
    await (ctx.db as any).insert(t).values({
      id: crypto.randomUUID(),
      userId: input.userId,
      action: input.action,
      collection: input.collection,
      itemId: input.itemId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      payload: input.payload ?? null,
    });
  } catch (e) {
    console.error("[activity] failed to record", e);
  }
};

export const requestMeta = (req: Request): { ip: string | null; userAgent: string | null } => {
  const ua = req.headers.get("user-agent");
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  return { ip, userAgent: ua };
};
