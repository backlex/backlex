/**
 * Tasks — a provider acting on ONE row, and what it answers written back.
 *
 * The three capabilities before this are all safe to repeat: a lost sink
 * delivery is a duplicate notification, a pull re-reads a page, a push re-sends
 * a batch the warehouse collapses. A task books a shipment. The second one
 * costs money and confuses a courier, so the whole design here is about running
 * exactly once and being able to prove it afterwards.
 *
 * The guard is a row in `integration_task_runs` under a unique index, not a
 * check this code performs: two concurrent callers race to INSERT and exactly
 * one wins. A caller that loses reads back what the winner produced instead of
 * being told "no" — an operator clicking twice wants the label, not an error.
 *
 * Order of operations, and none of it is arbitrary:
 *
 *   1. **Claim** the run row. Nothing has happened at the provider yet, so a
 *      crash here costs nothing.
 *   2. **Call** the provider. This is the only step with an outside effect.
 *   3. **Store** the artifact, if there is one. Before the row is written, so a
 *      row never names a storage key that does not exist.
 *   4. **Write** the outputs onto the row, through the caller's mapping.
 *   5. **Settle** the run row with what happened.
 *
 * A failure after step 2 leaves a `failed` run row holding the error. That is
 * deliberately NOT a claim: the retry re-runs, because the alternative is a
 * shipment that was booked, failed to record, and can never be recorded.
 */

import { and, eq, sql } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError } from "@backlex/core";
import {
  isRateLimited,
  providerFor,
  runIntegrationTask,
  SECRET_KEYS,
  taskFor,
  type FetchLike,
  type TaskResult,
} from "@backlex/integrations";
import type { Ctx } from "../context";
import { loadCollection } from "./items/collection-loader";
import { ingestRows } from "./migrate-ingest";
import { queryAll } from "./items/sql-helpers";
import { ensureAccessToken } from "./integrations-oauth";
import { decryptSecret, isEncryptedSecret } from "../lib/crypto";

type AnyDb = any;

const runsTableFor = (dialect: string) =>
  (dialect === "postgres"
    ? pg.schema.integrationTaskRuns
    : sqlite.schema.integrationTaskRuns) as typeof pg.schema.integrationTaskRuns;

const integrationsTableFor = (dialect: string) =>
  (dialect === "postgres"
    ? pg.schema.integrations
    : sqlite.schema.integrations) as typeof pg.schema.integrations;

export interface TaskRunInput {
  integrationId: string;
  /** Provider-declared task id. */
  task: string;
  collection: string;
  itemId: string;
  /** Per-invocation settings, checked against the task's declared fields. */
  settings?: Record<string, unknown>;
  /**
   * Declared output key → collection field. The caller owns this rather than a
   * stored config, because the same task serves collections that name their
   * columns differently — a flow step carries its own mapping.
   */
  outputMapping?: Record<string, string>;
  /**
   * Re-run a task that already succeeded.
   *
   * The escape hatch for a shipment that was cancelled at the carrier and has
   * to be booked again. Off by default, because the default has to be the safe
   * one — the guard exists precisely because a repeat has a cost.
   */
  force?: boolean;
}

export interface TaskRunResult {
  status: "succeeded" | "skipped";
  outputs: Record<string, unknown>;
  artifactKey: string | null;
  /** True when a previous run's result was returned rather than a new call made. */
  reused: boolean;
}

/** Decrypt this kind's secret config fields. Mirrors the sync service. */
const decryptConfig = async (
  kind: string,
  config: Record<string, unknown>,
  secret: string,
): Promise<Record<string, unknown>> => {
  const keys = new Set(SECRET_KEYS[kind as keyof typeof SECRET_KEYS] ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = keys.has(k) && typeof v === "string" && isEncryptedSecret(v) ? ((await decryptSecret(v, secret)) ?? "") : v;
  }
  return out;
};

/**
 * Settings are checked against what the task declared, and anything else is
 * REFUSED rather than forwarded.
 *
 * Same rule as a sync's settings, for the same reason: these reach a provider
 * and end up in URLs and request bodies, so an unrecognised key is an error
 * rather than something to pass along on the chance it is read.
 */
const validateTaskSettings = (
  kind: string,
  taskId: string,
  settings: Record<string, unknown>,
): Record<string, unknown> => {
  const task = taskFor(kind, taskId);
  if (!task) throw new AppError("BAD_REQUEST", `${kind} has no task "${taskId}"`);
  const declared = new Map((task.settingFields ?? []).map((f) => [f.key, f]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    const field = declared.get(k);
    if (!field) throw new AppError("VALIDATION", `${kind}.${taskId} has no setting "${k}"`);
    if (field.options && !field.options.some((o) => o.value === v)) {
      throw new AppError("VALIDATION", `"${k}" must be one of: ${field.options.map((o) => o.value).join(", ")}`);
    }
    out[k] = v;
  }
  return out;
};

/**
 * Check the output mapping against the task's declared outputs AND the
 * collection's writable fields.
 *
 * Both halves matter. An undeclared output key means the caller is mapping
 * something the provider will never return, so the column would stay empty and
 * nothing would say why. A non-writable target is dropped by `ingestRows`, and
 * the run would report a booked shipment whose tracking number went nowhere.
 */
const validateOutputMapping = (
  kind: string,
  taskId: string,
  mapping: Record<string, string>,
  collection: Awaited<ReturnType<typeof loadCollection>>,
): Record<string, string> => {
  const task = taskFor(kind, taskId)!;
  const declared = new Set(task.outputs.map((o) => o.key));
  const writable = new Set(collection.fields.filter((f) => !f.computed).map((f) => f.name));
  const out: Record<string, string> = {};
  for (const [key, target] of Object.entries(mapping)) {
    if (!declared.has(key)) {
      throw new AppError("VALIDATION", `${kind}.${taskId} has no output "${key}"`);
    }
    if (typeof target !== "string" || !writable.has(target)) {
      throw new AppError("VALIDATION", `Collection "${collection.slug}" has no writable field "${target}"`);
    }
    out[key] = target;
  }
  return out;
};

/**
 * The storage key an artifact is written under.
 *
 * Tenant-first so one workspace's objects are a prefix, and derived from the
 * run rather than from anything the provider said — a filename from a third
 * party is not something to build a path out of.
 */
const artifactKeyFor = (tenantId: string, runId: string, filename: string): string => {
  // Kept only for the extension, and only from a safe alphabet. The rest of the
  // name is ours: a provider-supplied path segment is how traversal happens.
  const ext = /\.([a-zA-Z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase();
  return `integration-tasks/${tenantId}/${runId}${ext ? `.${ext}` : ""}`;
};

/**
 * Run one task against one row.
 *
 * Throws on provider failure so a queued invocation retries with backoff. The
 * run row records the reason either way.
 */
export async function runTask(
  ctx: Ctx,
  tenantId: string,
  input: TaskRunInput,
  fetchImpl?: FetchLike,
): Promise<TaskRunResult> {
  const t = runsTableFor(ctx.dialect);
  const integrations = integrationsTableFor(ctx.dialect);

  // Scoped by tenant, so a task cannot be run through another workspace's
  // connection by naming its id.
  const [integration] = (await (ctx.db as AnyDb)
    .select()
    .from(integrations)
    .where(and(eq(integrations.tenantId, tenantId), eq(integrations.id, input.integrationId)))) as {
    id: string;
    kind: string;
    config: Record<string, unknown> | null;
    status: string;
  }[];
  if (!integration) throw new AppError("NOT_FOUND", "Integration not found");
  if (integration.status !== "connected") {
    throw new AppError("BAD_REQUEST", "Integration is not connected");
  }

  const task = taskFor(integration.kind, input.task);
  if (!task) throw new AppError("BAD_REQUEST", `${integration.kind} has no task "${input.task}"`);

  // Resolves within the caller's tenant and throws on an unknown slug, so a
  // task can never be aimed at another workspace's collection.
  const collection = await loadCollection(ctx, tenantId, input.collection);
  const settings = validateTaskSettings(integration.kind, input.task, input.settings ?? {});
  const outputMapping = validateOutputMapping(
    integration.kind,
    input.task,
    input.outputMapping ?? {},
    collection,
  );

  const [row] = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(collection.physicalTable)} WHERE ${sql.identifier(collection.pkColumn)} = ${input.itemId} LIMIT 1`,
  );
  if (!row) throw new AppError("NOT_FOUND", `No "${input.collection}" row with id ${input.itemId}`);

  // ── 1. Claim ───────────────────────────────────────────────────────────────
  const existing = await findRun(ctx, tenantId, input);
  if (existing?.status === "succeeded" && !input.force) {
    // Hand back the first run's answer rather than refusing. An operator who
    // clicked twice wants the label, and a flow that re-fired wants to carry on.
    return {
      status: "skipped",
      outputs: (existing.outputs ?? {}) as Record<string, unknown>,
      artifactKey: existing.artifactKey ?? null,
      reused: true,
    };
  }

  const runId = existing?.id ?? crypto.randomUUID();
  const now = new Date();
  if (existing) {
    await (ctx.db as AnyDb)
      .update(t)
      .set({ status: "running", attempts: (existing.attempts ?? 0) + 1, error: null, updatedAt: now })
      .where(eq(t.id, existing.id));
  } else {
    try {
      await (ctx.db as AnyDb).insert(t).values({
        id: runId,
        tenantId,
        integrationId: integration.id,
        task: input.task,
        collection: input.collection,
        itemId: input.itemId,
        status: "running",
        outputs: {},
        attempts: 1,
        createdAt: now,
        updatedAt: now,
      });
    } catch (e) {
      // The unique index is the guard. Losing this race means somebody else is
      // already booking this shipment, and the only safe answer is not to book
      // a second one.
      const again = await findRun(ctx, tenantId, input);
      if (again) {
        return {
          status: "skipped",
          outputs: (again.outputs ?? {}) as Record<string, unknown>,
          artifactKey: again.artifactKey ?? null,
          reused: true,
        };
      }
      throw e;
    }
  }

  // ── 2. Call the provider ───────────────────────────────────────────────────
  let config = await decryptConfig(
    integration.kind,
    (integration.config ?? {}) as Record<string, unknown>,
    ctx.env.AUTH_SECRET,
  );
  let result: TaskResult;
  try {
    if (providerFor(integration.kind)?.oauth) {
      const token = await ensureAccessToken(ctx, integration as never, ctx.env.AUTH_SECRET);
      if (!token) throw new AppError("UNAUTHORIZED", "OAuth connection needs re-authorizing");
      config = { ...config, _oauthAccessToken: token };
    }
    result = await runIntegrationTask(
      integration.kind,
      input.task,
      {
        config,
        settings,
        row,
        // Stable across every retry of this triple, so a provider that honours
        // an idempotency key refuses the duplicate at its own end too.
        idempotencyKey: runId,
        connectionKey: integration.id,
      },
      fetchImpl,
    );
  } catch (e) {
    await settle(ctx, runId, {
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
      rateLimited: isRateLimited(e),
    });
    throw e;
  }

  // ── 3. Store the artifact, before anything references it ───────────────────
  let artifactKey: string | null = null;
  if (result.artifact) {
    const key = artifactKeyFor(tenantId, runId, result.artifact.filename);
    await ctx.storage.put({
      key,
      body: result.artifact.bytes,
      contentType: result.artifact.contentType,
    });
    artifactKey = key;
  }

  // ── 4. Write the outputs onto the row ──────────────────────────────────────
  const values: Record<string, unknown> = { ...result.outputs };
  const artifactOutput = task.outputs.find((o) => o.artifact)?.key;
  if (artifactOutput && artifactKey) values[artifactOutput] = artifactKey;

  const patch: Record<string, unknown> = { [collection.pkColumn]: input.itemId };
  for (const [key, field] of Object.entries(outputMapping)) {
    if (values[key] !== undefined) patch[field] = values[key];
  }
  if (Object.keys(patch).length > 1) {
    const out = await ingestRows(ctx, collection, tenantId, [patch], { mode: "upsert" });
    if (out.failed.length > 0) {
      const error = `writing outputs to "${input.collection}" failed: ${out.failed[0]?.error ?? "unknown"}`;
      await settle(ctx, runId, { status: "failed", error });
      // The provider already acted. Failing loudly is right — a silent success
      // here would mean a booked shipment whose tracking number reached nobody.
      throw new AppError("VALIDATION", error);
    }
  }

  // ── 5. Settle ──────────────────────────────────────────────────────────────
  await settle(ctx, runId, { status: "succeeded", outputs: values, artifactKey });
  return { status: "succeeded", outputs: values, artifactKey, reused: false };
}

const findRun = async (ctx: Ctx, tenantId: string, input: TaskRunInput) => {
  const t = runsTableFor(ctx.dialect);
  const [row] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(
      and(
        eq(t.tenantId, tenantId),
        eq(t.integrationId, input.integrationId),
        eq(t.task, input.task),
        eq(t.collection, input.collection),
        eq(t.itemId, input.itemId),
      ),
    )) as {
    id: string;
    status: string;
    outputs: Record<string, unknown> | null;
    artifactKey: string | null;
    attempts: number;
  }[];
  return row ?? null;
};

const settle = async (
  ctx: Ctx,
  runId: string,
  outcome:
    | { status: "succeeded"; outputs: Record<string, unknown>; artifactKey: string | null }
    | { status: "failed"; error: string; rateLimited?: boolean },
): Promise<void> => {
  const t = runsTableFor(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set(
      outcome.status === "succeeded"
        ? { status: "succeeded", outputs: outcome.outputs, artifactKey: outcome.artifactKey, error: null, updatedAt: new Date() }
        : { status: "failed", error: outcome.error.slice(0, 500), updatedAt: new Date() },
    )
    .where(eq(t.id, runId));
};

/** Task runs for one row — what an item page shows next to its actions. */
export async function listTaskRuns(
  ctx: Ctx,
  tenantId: string,
  filter: { collection: string; itemId: string },
): Promise<
  { id: string; integrationId: string; task: string; status: string; outputs: Record<string, unknown>; artifactKey: string | null; error: string | null; attempts: number; updatedAt: Date | number | null }[]
> {
  const t = runsTableFor(ctx.dialect);
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(
      and(eq(t.tenantId, tenantId), eq(t.collection, filter.collection), eq(t.itemId, filter.itemId)),
    )) as any[];
  return rows.map((r) => ({
    id: r.id,
    integrationId: r.integrationId,
    task: r.task,
    status: r.status,
    outputs: (r.outputs ?? {}) as Record<string, unknown>,
    artifactKey: r.artifactKey ?? null,
    error: r.error ?? null,
    attempts: r.attempts ?? 1,
    updatedAt: r.updatedAt ?? null,
  }));
}
