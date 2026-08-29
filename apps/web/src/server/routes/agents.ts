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
import { readJson } from "../lib/body";
import {
  createSkill,
  deleteSkill,
  listSkills,
  parseSkillMarkdown,
  updateSkill,
} from "../services/agents/skills";
import { resolveCallerMcpGuards } from "../services/roles/mcp-guards";
import { AI_EFFORTS, type AiEffort } from "../mcp/ai-client";
import { allTools } from "../mcp/tools";
import { logActivity } from "../services/activity";
import {
  addThreadAgent,
  createAgent,
  createThread,
  deleteAgent,
  deleteThread,
  getAgent,
  getRun,
  getThread,
  listActiveRuns,
  listAgents,
  listAuthors,
  listMessages,
  listThreadAgentIds,
  listThreadAgentIdsFor,
  listThreads,
  removeThreadAgent,
  THREAD_ROUTINGS,
  updateAgent,
  updateThread,
  type ThreadRouting,
} from "../services/agents/store";
import { sendMessage } from "../services/agents/send";
import {
  forgetFact,
  listFacts,
  parseMemoryScope,
  rememberFact,
} from "../services/agents/memory";
import { readJsonOr } from "../lib/body";

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
  if (body.handle !== undefined) {
    // Normalised + de-duped by the store; validated here only for shape, since
    // handles allow unicode letters (mentions match the workspace's known
    // handles, not a fixed charset).
    if (body.handle !== null && typeof body.handle !== "string") {
      throw new AppError("VALIDATION", "handle must be a string");
    }
    if (typeof body.handle === "string" && /[\s@]/.test(body.handle)) {
      throw new AppError("VALIDATION", "handle cannot contain spaces or '@'");
    }
    out.handle = body.handle;
  }
  if (body.description !== undefined)
    out.description = body.description === null ? null : String(body.description);
  if (body.systemPrompt !== undefined)
    out.systemPrompt = body.systemPrompt === null ? null : String(body.systemPrompt);
  if (body.model !== undefined)
    out.model = body.model === null ? null : String(body.model);
  if (body.effort !== undefined) {
    if (body.effort === null || body.effort === "") out.effort = null;
    else if (AI_EFFORTS.includes(body.effort as AiEffort)) out.effort = body.effort;
    else
      throw new AppError(
        "VALIDATION",
        `effort must be one of ${AI_EFFORTS.join(", ")} (or null for the provider default)`,
      );
  }
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
  if (body.skills !== undefined) {
    // Names, not ids: the model addresses a skill by name and so does an
    // operator reading the definition. Existence is NOT checked here — a name
    // that does not resolve is simply not offered at run time, the same as a
    // tool removed after the agent was authored, and requiring the skill to
    // exist first would make ordering a template's seed data load-bearing.
    if (
      !Array.isArray(body.skills) ||
      body.skills.some((n) => typeof n !== "string" || !n.trim())
    ) {
      throw new AppError("VALIDATION", "skills must be an array of skill names");
    }
    out.skills = (body.skills as string[]).map((n) => n.trim());
  }
  if (body.maxSteps !== undefined) {
    const n = Number(body.maxSteps);
    if (!Number.isInteger(n) || n < 1 || n > 25) {
      throw new AppError("VALIDATION", "maxSteps must be an integer 1–25");
    }
    out.maxSteps = n;
  }
  if (body.memory !== undefined) out.memory = Boolean(body.memory);
  if (body.memoryScope !== undefined) {
    if (body.memoryScope !== "thread" && body.memoryScope !== "agent") {
      throw new AppError(
        "VALIDATION",
        "memoryScope must be 'thread' or 'agent'",
      );
    }
    out.memoryScope = body.memoryScope;
  }
  if (body.active !== undefined) out.active = Boolean(body.active);
  // Opening an agent to end users is an operator decision, made here and
  // nowhere else — the app-plane route only ever reads this flag.
  if (body.appAccess !== undefined) out.appAccess = Boolean(body.appAccess);
  return out;
};

/** Validate a room's routing mode, defaulting to mention-only. */
const parseRouting = (v: unknown): ThreadRouting => {
  if (v === undefined || v === null) return "mention";
  if (THREAD_ROUTINGS.includes(v as ThreadRouting)) return v as ThreadRouting;
  throw new AppError(
    "VALIDATION",
    `routing must be one of ${THREAD_ROUTINGS.join(", ")}`,
  );
};

const readBody = async (
  c: Parameters<MiddlewareHandler<AppBindings>>[0],
): Promise<Record<string, unknown>> => {
  const b = await readJsonOr(c.req, {});
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

  // ── rooms ────────────────────────────────────────────────────────────────
  // Registered BEFORE `/:id`, which would otherwise swallow `/threads` and
  // `/runs` as agent ids.

  /** Every conversation in the workspace, newest activity first, each with its
   *  participants so the room list can render agent chips without an N+1. */
  r.get("/threads", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const threads = await listThreads(ctx, tenantId);
    const members = await listThreadAgentIdsFor(ctx, threads.map((t) => t.id));
    return c.json({
      data: threads.map((t) => ({
        ...t,
        agentIds: members.get(t.id) ?? (t.agentId ? [t.agentId] : []),
      })),
    });
  });

  /** Open a room. With no `agentIds` it starts empty and answers nobody until
   *  agents are added — rooms are usable as plain team threads. */
  r.post("/threads", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const body = await readBody(c);
    const agentIds = Array.isArray(body.agentIds)
      ? (body.agentIds as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    for (const id of agentIds) {
      if (!(await getAgent(ctx, id, tenantId)))
        throw new AppError("VALIDATION", `unknown agent: ${id}`);
    }
    const thread = await createThread(ctx, tenantId, null, {
      title: typeof body.title === "string" ? body.title : null,
      createdBy: auth.userId,
      routing: parseRouting(body.routing),
      defaultAgentId:
        typeof body.defaultAgentId === "string" ? body.defaultAgentId : null,
      agentIds,
    });
    return c.json({ data: { ...thread, agentIds } }, 201);
  });

  // ---- Workspace skills -----------------------------------------------
  // Reusable procedural knowledge, in the open Agent Skills shape. Mounted
  // under `/api/agents` because they are only meaningful to an agent, and
  // admin-gated like everything else on this router.
  r.get("/skills", async (c) => {
    const ctx = c.get("ctx");
    return c.json({ data: await listSkills(ctx, requireTenant(c)) });
  });

  r.post("/skills", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    // `readJson`, not a swallowed parse: a malformed body should say so rather
    // than fall through to a validation error about a field the caller did
    // send. `request-envelope.test.ts` enforces this across every route.
    const body = await readJson<Record<string, unknown>>(c.req);
    // A raw `SKILL.md` is the point of using the open format — paste one
    // written for any other agent tool and it works here. Explicit fields still
    // win, so a caller can override the frontmatter without editing it.
    const parsed =
      typeof body.markdown === "string" ? parseSkillMarkdown(body.markdown) : null;
    const created = await createSkill(ctx, tenantId, {
      name: (body.name as string) ?? parsed?.name,
      description: (body.description as string) ?? parsed?.description,
      body: (body.body as string) ?? parsed?.body,
      active: body.active as boolean | undefined,
    });
    return c.json({ data: created }, 201);
  });

  r.patch("/skills/:id", async (c) => {
    const ctx = c.get("ctx");
    // `readJson`, not a swallowed parse: a malformed body should say so rather
    // than fall through to a validation error about a field the caller did
    // send. `request-envelope.test.ts` enforces this across every route.
    const body = await readJson<Record<string, unknown>>(c.req);
    await updateSkill(ctx, requireTenant(c), c.req.param("id"), {
      name: body.name as string | undefined,
      description: body.description as string | undefined,
      body: body.body as string | undefined,
      active: body.active as boolean | undefined,
    });
    return c.json({ data: { ok: true } });
  });

  r.delete("/skills/:id", async (c) => {
    const ctx = c.get("ctx");
    await deleteSkill(ctx, requireTenant(c), c.req.param("id"));
    return c.json({ data: { ok: true } });
  });

  r.get("/runs/:runId", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const run = await getRun(ctx, c.req.param("runId"), tenantId);
    if (!run) throw new AppError("NOT_FOUND", "Run not found");
    return c.json({ data: run });
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

  // ── memory ───────────────────────────────────────────────────────────────
  // The distilled semantic facts an agent holds. Episodic memory has no
  // endpoint on purpose: it's a verbatim copy of the transcript, which the
  // thread endpoints already serve, and exposing it would just be a second,
  // staler way to read the same conversation.

  /** `?threadId=` narrows to one conversation's pool; omit for everything. */
  r.get("/:id/memory", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const id = c.req.param("id");
    const agent = await getAgent(ctx, id, tenantId);
    if (!agent) throw new AppError("NOT_FOUND", "Agent not found");
    const threadId = c.req.query("threadId") ?? null;
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json({
      data: await listFacts(ctx, id, {
        threadId,
        limit: Number.isFinite(limit) ? limit : 100,
      }),
      meta: { scope: parseMemoryScope(agent.memoryScope) },
    });
  });

  /** Teach the agent a fact directly, without waiting for a distillation pass.
   *  Deduped against the pool exactly like a distilled one. */
  r.post("/:id/memory", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const id = c.req.param("id");
    const agent = await getAgent(ctx, id, tenantId);
    if (!agent) throw new AppError("NOT_FOUND", "Agent not found");
    const body = await readBody(c);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) throw new AppError("VALIDATION", "content is required");
    const scope = parseMemoryScope(agent.memoryScope);
    // A thread-scoped fact needs a home thread; an agent-scoped one doesn't,
    // and the empty string keeps it out of any single thread's pool.
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    if (scope === "thread" && !threadId) {
      throw new AppError(
        "VALIDATION",
        "threadId is required while this agent's memoryScope is 'thread'",
      );
    }
    const row = await rememberFact(ctx, {
      tenantId,
      agentId: id,
      threadId,
      scope,
      content,
    });
    if (!row) {
      // Not an error: the agent already knows this. Reporting it as one would
      // make every "teach it X" integration have to special-case a 409.
      return c.json({ data: null, meta: { deduped: true } });
    }
    await logActivity(c, {
      action: "update",
      collection: "system_agents",
      itemId: id,
      payload: { memory: "remember", content },
      response: { data: row },
    });
    return c.json({ data: row }, 201);
  });

  r.delete("/:id/memory/:memoryId", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const id = c.req.param("id");
    const agent = await getAgent(ctx, id, tenantId);
    if (!agent) throw new AppError("NOT_FOUND", "Agent not found");
    const ok = await forgetFact(ctx, id, c.req.param("memoryId"));
    if (!ok) throw new AppError("NOT_FOUND", "Memory not found");
    await logActivity(c, {
      action: "update",
      collection: "system_agents",
      itemId: id,
      payload: { memory: "forget", memoryId: c.req.param("memoryId") },
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
    const agentIds = await listThreadAgentIds(ctx, thread.id);
    return c.json({
      data: {
        thread,
        messages,
        authors,
        agentIds: agentIds.length > 0 ? agentIds : thread.agentId ? [thread.agentId] : [],
        // Turns in flight right now — a room can have several, one per agent,
        // so the client renders a working indicator per agent rather than one
        // global "busy".
        activeRuns: await listActiveRuns(ctx, thread.id),
      },
    });
  });

  r.patch("/threads/:threadId", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const threadId = c.req.param("threadId");
    const thread = await getThread(ctx, threadId, tenantId);
    if (!thread) throw new AppError("NOT_FOUND", "Thread not found");
    const body = await readBody(c);
    if (body.defaultAgentId != null) {
      if (typeof body.defaultAgentId !== "string")
        throw new AppError("VALIDATION", "defaultAgentId must be a string");
      if (!(await getAgent(ctx, body.defaultAgentId, tenantId)))
        throw new AppError("VALIDATION", `unknown agent: ${body.defaultAgentId}`);
    }
    await updateThread(ctx, threadId, tenantId, {
      ...(body.title !== undefined
        ? { title: body.title === null ? null : String(body.title) }
        : {}),
      ...(body.routing !== undefined ? { routing: parseRouting(body.routing) } : {}),
      ...(body.defaultAgentId !== undefined
        ? {
            defaultAgentId:
              body.defaultAgentId === null ? null : String(body.defaultAgentId),
          }
        : {}),
    });
    return c.json({ ok: true });
  });

  r.post("/threads/:threadId/agents", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const threadId = c.req.param("threadId");
    const thread = await getThread(ctx, threadId, tenantId);
    if (!thread) throw new AppError("NOT_FOUND", "Thread not found");
    const body = await readBody(c);
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    if (!agentId) throw new AppError("VALIDATION", "agentId is required");
    if (!(await getAgent(ctx, agentId, tenantId)))
      throw new AppError("NOT_FOUND", "Agent not found");
    await addThreadAgent(ctx, tenantId, threadId, agentId);
    return c.json({ ok: true });
  });

  r.delete("/threads/:threadId/agents/:agentId", async (c) => {
    const ctx = c.get("ctx");
    const tenantId = requireTenant(c);
    const threadId = c.req.param("threadId");
    const thread = await getThread(ctx, threadId, tenantId);
    if (!thread) throw new AppError("NOT_FOUND", "Thread not found");
    await removeThreadAgent(ctx, threadId, c.req.param("agentId"));
    return c.json({ ok: true });
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

  // ── send a message (and run whoever it wakes) ─────────────────────────────
  //
  // Sync by default — the pre-rooms shape, still what the SDK / CLI / MCP /
  // GraphQL callers get, answer and all. `async: true` queues the turns and
  // answers with run ids instead; that's what a multi-agent room uses, since
  // several agents can't take turns holding one response open.
  r.post("/threads/:threadId/messages", async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const tenantId = requireTenant(c);
    const threadId = c.req.param("threadId");
    const body = await readBody(c);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw new AppError("VALIDATION", "message is required");
    // Explicit responders — how a caller that already knows which agent it
    // wants (the SDK/MCP/CLI `run` shape) bypasses the room's routing mode.
    const forceAgentIds = Array.isArray(body.agentIds)
      ? (body.agentIds as unknown[]).filter((v): v is string => typeof v === "string")
      : undefined;

    const start = Date.now();
    const result = await sendMessage({
      ctx,
      app: app as unknown as Hono,
      env,
      tenantId,
      threadId,
      message,
      auth: {
        userId: auth.userId,
        // Resolved HERE, where the credential that asked for the turn is still
        // in hand. The MCP `agents.run` tool reaches this endpoint through an
        // in-process sub-fetch that forwards the caller's Authorization header,
        // so `c.var.auth` carries that key's own MCP guards on this request
        // too — which is why one resolution at this seam covers both the direct
        // REST caller and the agent-over-MCP one.
        guards: await resolveCallerMcpGuards(ctx, auth),
      },
      request: c.req.raw,
      forceAgentIds,
      async: Boolean(body.async),
      background: (p) => {
        try {
          c.executionCtx?.waitUntil?.(p);
        } catch {
          /* no ExecutionContext (Bun/Node) — the promise runs regardless */
        }
      },
    });

    for (const turn of result.turns) {
      await logActivity(c, {
        action: "agent.run",
        collection: "system_agents",
        itemId: result.runs[result.turns.indexOf(turn)]?.agentId ?? threadId,
        payload: {
          threadId,
          steps: turn.steps.length,
          stoppedReason: turn.stoppedReason,
          durationMs: Date.now() - start,
          // What the prompt cache saved on this turn, in input tokens billed at
          // ~0.1× instead of full price.
          cachedTokens: turn.cachedTokens,
        },
        response: { ok: true },
      });
    }

    // Async: nothing has run yet, so there's no answer to return.
    if (body.async) {
      return c.json(
        {
          data: {
            messageId: result.messageId,
            runs: result.runs,
            busy: result.busy,
          },
        },
        202,
      );
    }
    // Sync: the first turn's fields stay at the top level so every existing
    // caller keeps reading `data.answer`; `turns` carries the rest when a
    // message woke more than one agent.
    const first = result.turns[0];
    return c.json({
      data: {
        answer: first?.answer ?? "",
        steps: first?.steps ?? [],
        stoppedReason: first?.stoppedReason ?? "final",
        cachedTokens: first?.cachedTokens ?? 0,
        messageId: result.messageId,
        runs: result.runs,
        busy: result.busy,
        turns: result.turns,
      },
    });
  });

  return r;
};
