import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import type { AppBindings } from "../app";
import type { Env } from "../env";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import {
  type ChannelStats,
  getLocalChannelStats,
} from "../services/events";
import { isStatelessEdge } from "../lib/runtime";

/**
 * Read-only diagnostics for the realtime layer. Surfaces per-channel state
 * (connected sockets, presence members, latest seq, replay buffer size) so
 * an operator can spot a hot channel before it bumps the per-DO connection
 * ceiling. Stats only — no mutation, no test-publish.
 *
 * Runtime support:
 *   - CF Workers       → fans out to each channel's Durable Object
 *   - Bun self-host    → reads the in-process maps in `services/events.ts`
 *   - Vercel / Netlify → 503 (realtime is unsupported on these runtimes)
 */

const COLLECTIONS_CHANNEL = "collections";
const ITEMS_PREFIX = "items:";

const requireAdminMw: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin))
    throw new AppError("FORBIDDEN", "Admin role required");
  await next();
};

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const refuseOnStatelessEdge = (): void => {
  if (isStatelessEdge()) {
    throw new AppError(
      "UNAVAILABLE",
      "Realtime is not available on Vercel Edge / Netlify Edge — deploy to Cloudflare Workers (with REALTIME Durable Object binding) or Bun.",
    );
  }
};

const ZERO_STATS: ChannelStats = {
  connectedSockets: 0,
  presenceMembers: 0,
  currentSeq: 0,
  logSize: 0,
};

const StatsSchema = z
  .object({
    connectedSockets: z.number().int().nonnegative(),
    presenceMembers: z.number().int().nonnegative(),
    currentSeq: z.number().int().nonnegative(),
    logSize: z.number().int().nonnegative(),
  })
  .openapi("RealtimeChannelStats");

const ChannelRowSchema = z
  .object({
    channel: z.string(),
    stats: StatsSchema,
  })
  .openapi("RealtimeChannelRow");

/** Fetch stats for one channel through whichever transport this runtime uses.
 *  Worker errors are absorbed into a zero-stats row — the admin page would
 *  rather render the channel as "0 connected" than crash on a stale DO. */
const fetchStats = async (
  env: Env,
  channel: string,
): Promise<ChannelStats> => {
  if (env.REALTIME) {
    try {
      const stub = env.REALTIME.get(env.REALTIME.idFromName(channel));
      const res = await stub.fetch("https://do/stats");
      if (!res.ok) return ZERO_STATS;
      return (await res.json()) as ChannelStats;
    } catch {
      return ZERO_STATS;
    }
  }
  return getLocalChannelStats(channel);
};

const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

export const realtimeAdminRoutes = new OpenAPIHono<AppBindings>()
  .openapi(
    createRoute({
      method: "get",
      path: "/channels",
      tags: ["realtime-admin"],
      summary: "List realtime channels for the active workspace",
      description:
        "Returns per-channel stats for every `items:<slug>` channel of an active collection plus the workspace's `collections` schema-events channel. " +
        "`presence:*` and free-form channels aren't enumerated (CF Workers can't list Durable Objects); use `/{channel}/stats` to probe a known name.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(ChannelRowSchema) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      refuseOnStatelessEdge();
      const ctx = c.get("ctx");
      const tenantId = requireTenant(c);
      const t = collectionsTable(ctx.dialect);

      const rows = (await (ctx.db as any)
        .select({ slug: t.slug })
        .from(t)
        .where(
          and(eq(t.tenantId, tenantId), eq(t.status, "active")),
        )) as Array<{ slug: string }>;

      const channels = [
        COLLECTIONS_CHANNEL,
        ...rows.map((r) => `${ITEMS_PREFIX}${r.slug}`),
      ];

      // Parallel fan-out; each entry isolated so one slow DO doesn't block
      // the whole page. The Worker DO RPC is cheap (single message); CPU
      // budget shouldn't matter even at hundreds of collections.
      const env = ctx.env;
      const data = await Promise.all(
        channels.map(async (channel) => ({
          channel,
          stats: await fetchStats(env, channel),
        })),
      );

      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/channels/{channel}/stats",
      tags: ["realtime-admin"],
      summary: "Stats for a single realtime channel",
      description:
        "Targeted lookup — use this for `presence:*` or free-form channels that aren't on the enumeration list, or to refresh a single row without re-fanning out.",
      security: SECURITY,
      middleware: [requireUser, requireAdminMw],
      request: {
        params: z.object({
          channel: z.string().min(1).openapi({
            description: "Channel name (e.g. `items:posts`, `presence:room-1`).",
          }),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: ChannelRowSchema }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      refuseOnStatelessEdge();
      const { channel } = c.req.valid("param");
      const stats = await fetchStats(c.get("ctx").env, channel);
      return c.json({ data: { channel, stats } });
    },
  );

export default realtimeAdminRoutes;
