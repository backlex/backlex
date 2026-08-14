import { Hono, type Context } from "hono";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { findTenantBySlugOrId } from "../services/tenant-auth";
import {
  createThread,
  getAgent,
  getThread,
  listAgents,
  listMessages,
  listThreads,
  threadTitleFrom,
} from "../services/agents/store";
import { sendMessage } from "../services/agents/send";

/**
 * End-user-facing agent chat, mounted at `/api/t/:slug/agents`.
 *
 * Every other AI surface in the product is `requireAdmin`, which made AI the
 * one backlex primitive a customer's own users could never touch — no support
 * bot, no in-product assistant, unless the customer proxied it themselves and
 * put their own key behind it.
 *
 * What makes this safe to open is that the end user supplies only a MESSAGE.
 * The operator writes the system prompt, picks the tools, and opts the agent in
 * — so the prompt-injection surface and the spend stay where the operator can
 * see them. A general "generate" endpoint would instead be free model access on
 * somebody else's bill.
 *
 * Three things enforce that, and they are independent:
 *
 *   1. `agents.app_access` — off by default. A workspace's existing agents were
 *      built when only operators could reach them; some carry internal prompts
 *      and privileged tools. Exposure is a decision per agent, never a side
 *      effect of this route shipping.
 *   2. Thread ownership — a thread is readable and writable only by the end
 *      user who started it. An operator still sees every thread through the
 *      admin surface, which is what makes a support conversation reviewable.
 *   3. The agent's tool calls run as **the end user**. `sendMessage` re-enters
 *      the API in-process carrying this request's identity, so the permission
 *      DSL applies unchanged: an agent can read exactly what the person talking
 *      to it can read, and nothing more. This is the property that makes tools
 *      safe to leave enabled; without it, "ask the agent" would be a way to
 *      read your neighbour's rows.
 *
 * Cost is metered without anything here doing so: the runner carries the
 * workspace's meter sink, so an end-user turn lands in `usage_counters` the
 * same as an operator's.
 */

/** The signed-in end user, or 401. Also pins the request to the workspace named
 *  in the path: the session already carries its own tenant, so a mismatched
 *  slug means the caller is pointing a token at the wrong workspace. */
const requireAppUser = async (
  c: Context<AppBindings>,
): Promise<{ tenantId: string; appUserId: string }> => {
  const auth = c.get("auth");
  if (auth.plane !== "app" || !auth.userId)
    throw new AppError("UNAUTHORIZED", "Workspace end-user sign-in required");
  const tenantId = auth.tenantId;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Session is not bound to a workspace");

  const ctx = c.get("ctx");
  const slug = c.req.param("slug");
  const tenant = slug
    ? await findTenantBySlugOrId({ db: ctx.db, dialect: ctx.dialect }, slug)
    : null;
  if (!tenant) throw new AppError("NOT_FOUND", `Workspace "${slug ?? ""}" not found`);
  if (tenant.id !== tenantId)
    throw new AppError("FORBIDDEN", "Session belongs to a different workspace");
  return { tenantId, appUserId: auth.userId };
};

/** What an end user is allowed to know about an agent: enough to render a
 *  picker. Never the system prompt, the model, or the tool list — those are the
 *  operator's configuration, and the prompt in particular is exactly what an
 *  attacker wants before trying to talk around it. */
const publicAgent = (a: {
  id: string;
  name: string;
  handle: string | null;
  description: string | null;
}) => ({ id: a.id, name: a.name, handle: a.handle, description: a.description });

/** An agent this workspace has opened to its end users, or 404. Deliberately
 *  404 rather than 403: whether a private agent exists is not something an end
 *  user gets to learn by guessing ids. */
const requireOpenAgent = async (
  c: Context<AppBindings>,
  tenantId: string,
  agentId: string,
) => {
  const ctx = c.get("ctx");
  const agent = await getAgent(ctx, agentId, tenantId);
  if (!agent || !agent.active || !agent.appAccess)
    throw new AppError("NOT_FOUND", "Agent not found");
  return agent;
};

/** A thread the caller started, on an agent still open to end users. Both
 *  halves matter: the first stops one end user reading another's conversation,
 *  the second stops a thread outliving the operator's decision to close the
 *  agent it belongs to. */
const requireOwnThread = async (
  c: Context<AppBindings>,
  tenantId: string,
  appUserId: string,
  threadId: string,
) => {
  const ctx = c.get("ctx");
  const thread = await getThread(ctx, threadId, tenantId);
  if (!thread || thread.createdBy !== appUserId)
    throw new AppError("NOT_FOUND", "Thread not found");
  if (thread.agentId) await requireOpenAgent(c, tenantId, thread.agentId);
  return thread;
};

/** Takes the app so a turn's tool calls can re-enter it in-process — the same
 *  shape `agentsRoutes` uses. */
export const appAgentsPublicRoutes = (app: Hono<AppBindings>) =>
  new Hono<AppBindings>()
  /** The agents this workspace exposes to its end users. */
  .get("/:slug/agents", async (c) => {
    const { tenantId } = await requireAppUser(c);
    const ctx = c.get("ctx");
    const agents = await listAgents(ctx, tenantId);
    return c.json({
      data: agents.filter((a) => a.active && a.appAccess).map(publicAgent),
    });
  })

  /** My conversations. Scoped to the caller — never the workspace's. */
  .get("/:slug/agents/threads", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const ctx = c.get("ctx");
    const threads = await listThreads(ctx, tenantId);
    const open = new Set(
      (await listAgents(ctx, tenantId))
        .filter((a) => a.active && a.appAccess)
        .map((a) => a.id),
    );
    return c.json({
      data: threads
        .filter((t) => t.createdBy === appUserId && t.agentId && open.has(t.agentId))
        .map((t) => ({
          id: t.id,
          agentId: t.agentId,
          title: t.title,
          status: t.status,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
    });
  })

  /** Start a conversation with one of them. */
  .post("/:slug/agents/threads", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const ctx = c.get("ctx");
    const body = (await c.req.json().catch(() => ({}))) as {
      agentId?: unknown;
      title?: unknown;
    };
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    if (!agentId) throw new AppError("VALIDATION", "agentId is required");
    await requireOpenAgent(c, tenantId, agentId);

    const thread = await createThread(ctx, tenantId, agentId, {
      title: typeof body.title === "string" ? threadTitleFrom(body.title) : null,
      // The ownership record the read guards check. An end user's id and an
      // operator's live in the same column; the guards always pair it with the
      // agent's `app_access`, so the two populations never resolve to the same
      // thread by accident.
      createdBy: appUserId,
      // "default" rather than "mention": a one-to-one chat has exactly one
      // agent, and mention-only routing would answer nothing until the user
      // learned to type a handle they were never shown.
      routing: "default",
      defaultAgentId: agentId,
    });
    return c.json({ data: { id: thread.id, agentId, title: thread.title } }, 201);
  })

  /** The transcript. */
  .get("/:slug/agents/threads/:threadId/messages", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const ctx = c.get("ctx");
    const thread = await requireOwnThread(
      c,
      tenantId,
      appUserId,
      c.req.param("threadId"),
    );
    const messages = await listMessages(ctx, thread.id);
    return c.json({
      // `tool` rows are the agent's working-out — which tool it called and with
      // what arguments. An operator reviews those; an end user reading them
      // learns the workspace's internal shape, so the transcript is the
      // conversation only.
      data: messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          agentId: m.agentId,
          createdAt: m.createdAt,
        })),
    });
  })

  /** Say something, and get the reply. */
  .post("/:slug/agents/threads/:threadId/messages", async (c) => {
    const { tenantId, appUserId } = await requireAppUser(c);
    const ctx = c.get("ctx");
    const thread = await requireOwnThread(
      c,
      tenantId,
      appUserId,
      c.req.param("threadId"),
    );
    const body = (await c.req.json().catch(() => ({}))) as { message?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) throw new AppError("VALIDATION", "message is required");

    const result = await sendMessage({
      ctx,
      app: app as unknown as Hono,
      env: ctx.env,
      tenantId,
      threadId: thread.id,
      message,
      auth: { userId: appUserId },
      // The identity the agent's tool calls inherit. This is the line that
      // makes the whole surface safe: the turn re-enters the API as the END
      // USER, so the permission DSL narrows it exactly as it narrows them.
      request: c.req.raw,
      background: (p) => {
        try {
          c.executionCtx?.waitUntil?.(p);
        } catch {
          /* no ExecutionContext (Bun/Node) — the promise runs regardless */
        }
      },
    });

    return c.json({
      data: {
        // One reply per turn, paired with the agent that produced it: `turns`
        // is in responder order and `runs` names the responders, so the two
        // line up. `steps` is deliberately not returned — the agent's
        // working-out is for the operator's review surface.
        replies: result.turns.map((t, i) => ({
          agentId: result.runs[i]?.agentId ?? null,
          content: t.answer,
        })),
      },
    });
  });
