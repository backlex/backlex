/**
 * Public analytics ingest (#22) — where browser, mobile and server SDKs post
 * tracked events and crash reports.
 *
 * **Auth.** Three ways in, checked in order:
 *   1. `X-Backlex-Ingest-Key` — a *publishable* `alk_…` token minted per
 *      workspace. It ships inside client bundles, so it grants append-only
 *      ingest and nothing else: it can't read a single row back.
 *   2. A normal API key / admin session (server-side SDK use).
 *   3. A workspace end-user session (app plane).
 *
 * A request with none of those is rejected — anonymous ingest into an
 * arbitrary workspace would let anyone poison another tenant's numbers.
 *
 * **What the origin allow-list does and does not do here.** The global CORS
 * layer only echoes an origin that `APP_URL` or the workspace's configured
 * origins cover, so a BROWSER caller on an unlisted origin cannot read the
 * response — and because the SDK sends `credentials: "include"`, it cannot
 * preflight either. It is not, however, what protects a leaked key: CORS never
 * refuses the write itself, and a non-browser caller sends no `Origin` at all,
 * which this app treats as same-origin. A scraped publishable key is replayed
 * from curl, a mobile build or a server — none of which the allow-list sees.
 * What bounds one is this route being append-only, reading nothing back, and
 * the per-(workspace, IP) budget below.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { PUBLIC_SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { rateLimitOk } from "../lib/rate-limit";
import { setMeterTenant } from "../lib/usage-meter";
import { requestMeta } from "../services/activity";
import { enrichmentFromRequest } from "../services/analytics-enrich";
import {
  MAX_BATCH,
  recordErrors,
  recordEvents,
  resolveIngestKey,
} from "../services/analytics";
import type { Context } from "hono";

const TAGS = ["analytics"];

/** Per-workspace, per-IP ingest budget. Generous — a single page view can
 *  legitimately fire several events — but bounded, so one browser tab can't
 *  turn into a write flood. Batching keeps well-behaved clients far under it. */
export const INGEST_MAX_PER_MINUTE = 120;
const INGEST_WINDOW_MS = 60_000;

export const INGEST_KEY_HEADER = "x-backlex-ingest-key";

const EventInput = z
  .object({
    name: z.string().min(1).max(120),
    distinctId: z.string().min(1).max(200),
    userId: z.string().max(200).nullish(),
    sessionId: z.string().max(200).nullish(),
    props: z.record(z.string(), z.unknown()).nullish(),
    path: z.string().max(1000).nullish(),
    referrer: z.string().max(1000).nullish(),
    source: z.string().max(40).nullish(),
    release: z.string().max(80).nullish(),
    country: z.string().max(8).nullish(),
    /** Epoch ms. Defaults to server time; clamped to −7d / +5min. */
    ts: z.number().int().optional(),
  })
  .openapi("AnalyticsEventInput");

const ErrorInput = z
  .object({
    message: z.string().min(1).max(2000),
    type: z.string().max(120).nullish(),
    stack: z.string().max(20_000).nullish(),
    level: z.enum(["error", "warning", "fatal"]).nullish(),
    platform: z.string().max(40).nullish(),
    release: z.string().max(80).nullish(),
    url: z.string().max(1000).nullish(),
    userId: z.string().max(200).nullish(),
    distinctId: z.string().max(200).nullish(),
    sessionId: z.string().max(200).nullish(),
    context: z.record(z.string(), z.unknown()).nullish(),
    ts: z.number().int().optional(),
  })
  .openapi("AnalyticsErrorInput");

const IngestResult = z
  .object({
    accepted: z.number().int(),
    /** Malformed rows dropped from the batch — surfaced rather than silently
     *  swallowed, so a client can spot a broken payload shape. */
    rejected: z.number().int(),
  })
  .openapi("AnalyticsIngestResult");

/**
 * Resolve which workspace this ingest request writes to, and enforce the
 * per-workspace/IP budget. Throws rather than returning null so every caller
 * gets the same failure shape.
 */
const resolveIngestTenant = async (
  c: Context<AppBindings>,
): Promise<string | null> => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  const dbCtx = { db: ctx.db, dialect: ctx.dialect };

  const headerKey = c.req.header(INGEST_KEY_HEADER)?.trim();
  let tenantId: string | null;
  if (headerKey) {
    const hit = await resolveIngestKey(dbCtx, headerKey);
    if (!hit) throw new AppError("UNAUTHORIZED", "Invalid ingest key.");
    tenantId = hit.tenantId;
  } else if (auth?.userId || auth?.apiKeyId) {
    tenantId = auth.tenantId ?? auth.apiKeyTenantId ?? null;
  } else {
    throw new AppError(
      "UNAUTHORIZED",
      "Analytics ingest requires an ingest key or an authenticated session.",
    );
  }

  // Public path: no authenticated identity is guaranteed, so the resolved
  // workspace is what attributes this request for usage metering.
  setMeterTenant(c, tenantId);

  const ip = requestMeta(c.req.raw, c.get("ctx").env).ip ?? "unknown";
  const ok = await rateLimitOk(
    ctx.env,
    `analytics-ingest:${tenantId ?? "_default"}:${ip}`,
    INGEST_MAX_PER_MINUTE,
    INGEST_WINDOW_MS,
  );
  if (!ok) {
    throw new AppError(
      "RATE_LIMITED",
      `Too many ingest requests. Limit is ${INGEST_MAX_PER_MINUTE} per minute; batch your events.`,
    );
  }
  return tenantId;
};

export const analyticsIngestRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "post",
      path: "/events",
      tags: TAGS,
      summary: "Track product events",
      description:
        "Append a batch of tracked product events. Authenticate with a publishable " +
        "`X-Backlex-Ingest-Key` header (browser/mobile) or a normal API key / session " +
        "(server-side). Append-only: this endpoint can never read data back. " +
        `At most ${MAX_BATCH} events per request. Malformed rows are dropped and ` +
        "counted in `rejected` rather than failing the whole batch, so one bad " +
        "event can't cost a mobile client its offline queue.",
      security: PUBLIC_SECURITY,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ events: z.array(EventInput).min(1).max(MAX_BATCH) }),
            },
          },
        },
      },
      responses: {
        202: {
          description: "Accepted",
          content: { "application/json": { schema: IngestResult } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = await resolveIngestTenant(c);
      const { events } = c.req.valid("json");

      // Server-derived dimensions. Read once per request (they are properties
      // of the connection, not of an individual event) and layered over the
      // payload rather than under it: a client cannot know its own device
      // better than its user-agent says, and cannot be trusted about its own
      // country at all. `country` is the one field a caller may still supply —
      // a server-side SDK relaying events on behalf of real visitors knows
      // their geo when we don't — so the derived value wins only when present.
      const ctxFields = enrichmentFromRequest(c.req.raw);
      const enriched = events.map((e) => ({
        ...e,
        deviceType: ctxFields.deviceType,
        browser: ctxFields.browser,
        os: ctxFields.os,
        country: ctxFields.country ?? e.country ?? null,
      }));

      const result = await recordEvents(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        enriched as Parameters<typeof recordEvents>[2],
      );
      return c.json(result, 202);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/errors",
      tags: TAGS,
      summary: "Report crashes / errors",
      description:
        "Append a batch of error occurrences. Same auth as `/events`. Occurrences " +
        "are fingerprinted (type + normalized message + top stack frames) and folded " +
        "into an error group, so a crash firing thousands of times stays one row to " +
        "triage. A new occurrence reopens a group that was marked resolved; a group " +
        "explicitly ignored stays ignored.",
      security: PUBLIC_SECURITY,
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ errors: z.array(ErrorInput).min(1).max(MAX_BATCH) }),
            },
          },
        },
      },
      responses: {
        202: {
          description: "Accepted",
          content: {
            "application/json": {
              schema: IngestResult.extend({ groups: z.array(z.string()) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const tenantId = await resolveIngestTenant(c);
      const { errors } = c.req.valid("json");
      const result = await recordErrors(
        { db: ctx.db, dialect: ctx.dialect },
        tenantId,
        errors as Parameters<typeof recordErrors>[2],
      );
      return c.json(result, 202);
    },
  );
