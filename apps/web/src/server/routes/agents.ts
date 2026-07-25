/**
 * AI agent framework routes — CRUD for agent definitions + threads, and the
 * turn endpoint that runs an agent against a thread. Admin-only (platform
 * plane), mounted at `/api/agents`.
 *
 * Like `mcp.ts` and `ai-ask.ts`, this is a factory that closes over the parent
 * Hono `app` + `env` so the run loop can issue in-process sub-fetches against
 * the same REST surface (carrying the caller's identity), which is how agent
 * tool calls inherit the permission DSL.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import type { Env } from "../env";
import { requireUser } from "../middleware/session";
import { makeInternalFetch } from "../mcp/internal-fetch";
import { allTools } from "../mcp/tools";
import { logActivity } from "../services/activity";
import {
  createAgent,
  createThread,
  deleteAgent,
  deleteThread,
  getAgent,
  getThread,
  listAgents,
  listAuthors,
  listMessages,
  listThreads,
  updateAgent,
} from "../services/agents/store";
import { runAgentTurn } from "../services/agents/runner";

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const KNOWN_TOOLS = new Set(allTools.map((t) => t.name));

/** Validate + normalise the agent-definition body. Tools must reference real
 *  MCP tool names so a typo surfaces at create time, not at run time. */
const parseAgentInput = (body: Record<string, unknown>, partial: boolean) => {
  const out: Record<string, unknown> = {};
  if (body.name !== undefined || !partial) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new AppError("VALIDATION", "name is required");
    }
    out.name = body.name.trim();
  }
  if (body.description !== undefined)
    out.description = body.description === null ? null : String(body.description);
  if (body.systemPrompt !== undefined)
    out.systemPrompt = body.systemPrompt === null ? null : String(body.systemPrompt);
  if (body.model !== undefined)
    out.model = body.model === null ? null : String(body.model);
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.some((t) => typeof t !== "string")) {
      throw new AppError("VALIDATION", "tools must be an array of tool names");
    }
    const unknown = (body.tools as string[]).filter((t) => !KNOWN_TOOLS.has(t));
    if (unknown.length) {
      throw new AppError("VALIDATION", `unknown tool(s): ${unknown.join(", ")}`);
    }
    out.tools = body.tools;
  }
  if (body.maxSteps !== undefined) {
    const n = Number(body.maxSteps);
    if (!Number.isInteger(n) || n < 1 || n > 25) {
      throw new AppError("VALIDATION", "maxSteps must be an integer 1–25");
    }
    out.maxSteps = n;
  }
  if (body.memory !== undefined) out.memory = Boolean(body.memory);
  if (body.active !== undefined) out.active = Boolean(body.active);
  return out;
};

const readBody = async (
  c: Parameters<MiddlewareHandler<AppBindings>>[0],
): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === "object" && !Array.isArray(b)
    ? (b as Record<string, unknown>)
    : {};
};

export const agentsRoutes = (app: Hono<AppBindings>, env: Env) => {
  const r = new Hono<AppBindings>();
  r.use("*", requireUser, requireAdmin);

  // ── agents ───────────────────────────────────────────────────────────────
  r.get("/", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    return c.json({ data: await listAgents(ctx, tenantId) });
  });

  r.post("/", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const input = parseAgentInput(await readBody(c), false);
    const created = await createAgent(ctx, tenantId, input as any);
    await logActivity(c, {
      action: "create",
      collection: "system_agents",
      itemId: created.id,
      payload: { name: created.name },
      response: { data: created },
    });
    return c.json({ data: created }, 201);
  });

  r.get("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const agent = await getAgent(ctx, c.req.param("id"), tenantId);
    if (!agent) throw new AppError("NOT_FOUND", "Agent not found");
    return c.json({ data: agent });
  });

  r.patch("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const id = c.req.param("id");
    const existing = await getAgent(ctx, id, tenantId);
    if (!existing) throw new AppError("NOT_FOUND", "Agent not found");
    const input = parseAgentInput(await readBody(c), true);
    await updateAgent(ctx, id, tenantId, input as any);
    await logActivity(c, {
      action: "update",
      collection: "system_agents",
      itemId: id,
      payload: input,
      response: { ok: true },
    });
    return c.json({ ok: true });
  });

  r.delete("/:id", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const id = c.req.param("id");
    await deleteAgent(ctx, id, tenantId);
    await logActivity(c, {
      action: "delete",
      collection: "system_agents",
      itemId: id,
      response: { ok: true },
    });
    return c.json({ ok: true });
  });

  // ── threads ──────────────────────────────────────────────────────────────
  r.get("/:id/threads", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const id = c.req.param("id");
    const agent = await getAgent(ctx, id, tenantId);
    if (!agent) throw new AppError("NOT_FOUND", "Agent not found");
    return c.json({ data: await listThreads(ctx, tenantId, id) });
  });

  r.post("/:id/threads", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const id = c.req.param("id");
    const agent = await getAgent(ctx, id, tenantId);
    if (!agent) throw new AppError("NOT_FOUND", "Agent not found");
    const body = await readBody(c);
    const thread = await createThread(ctx, tenantId, id, {
      title: typeof body.title === "string" ? body.title : null,
      createdBy: auth.userId,
    });
    return c.json({ data: thread }, 201);
  });

  r.get("/threads/:threadId", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const thread = await getThread(ctx, c.req.param("threadId"), tenantId);
    if (!thread) throw new AppError("NOT_FOUND", "Thread not found");
    const messages = await listMessages(ctx, thread.id);
    // Threads are team-wide, so a transcript can mix several authors — ship
    // the people alongside it instead of making the client fetch each one.
    const authors = await listAuthors(ctx, [
      ...messages.map((m) => m.userId),
      thread.createdBy,
    ]);
    return c.json({ data: { thread, messages, authors } });
  });

  r.delete("/threads/:threadId", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const threadId = c.req.param("threadId");
    const thread = await getThread(ctx, threadId, tenantId);
    if (!thread) throw new AppError("NOT_FOUND", "Thread not found");
    await deleteThread(ctx, threadId, tenantId);
    return c.json({ ok: true });
  });

  // ── run a turn ─────────────────────────────────────────────────────────────
  r.post("/threads/:threadId/messages", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const threadId = c.req.param("threadId");
    const thread = await getThread(ctx, threadId, tenantId);
    if (!thread) throw new AppError("NOT_FOUND", "Thread not found");
    if (thread.status === "running") {
      // A live turn heartbeats `updatedAt` on every persisted step (appendMessage
      // bumps it). If it's gone quiet for longer than a step could take, the
      // previous turn's request was canceled/killed mid-run (e.g. the client
      // disconnected) and never reset the status — otherwise it's a genuine
      // in-flight turn. Only block on a fresh one; let this turn take over a stale
      // "running" so a zombie can't wedge the thread forever.
      const updatedMs =
        typeof thread.updatedAt === "number"
          ? thread.updatedAt
          : new Date(thread.updatedAt).getTime();
      const STALE_TURN_MS = 120_000;
      if (Date.now() - updatedMs < STALE_TURN_MS) {
        throw new AppError("CONFLICT", "A turn is already running on this thread");
      }
    }
    const body = await readBody(c);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw new AppError("VALIDATION", "message is required");

    const fetchInternal = makeInternalFetch(
      app as unknown as Hono,
      c.req.raw,
      env,
    );
    const start = Date.now();
    const result = await runAgentTurn({
      ctx,
      agentId: thread.agentId,
      threadId,
      tenantId,
      message,
      fetchInternal,
      auth: { userId: auth.userId },
    });
    await logActivity(c, {
      action: "agent.run",
      collection: "system_agents",
      itemId: thread.agentId,
      payload: {
        threadId,
        steps: result.steps.length,
        stoppedReason: result.stoppedReason,
        durationMs: Date.now() - start,
      },
      response: { ok: true },
    });
    return c.json({ data: result });
  });

  return r;
};
