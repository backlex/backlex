import type { ClientCore } from "../core";

/** An AI agent definition. Mirrors `/api/agents`. */
export interface Agent {
  id: string;
  tenantId?: string | null;
  name: string;
  /** Stable `@`-mention token, unique per workspace. This is what you type
   *  after `@` in a room to address the agent. */
  handle?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  model?: string | null;
  /** Reasoning effort (`low` | `medium` | `high`); null = provider default.
   *  Lower effort = fewer thinking tokens and fewer tool calls. Ignored by
   *  models that don't support it. */
  effort?: string | null;
  /** Allow-list of MCP tool names the agent may call. */
  tools: string[];
  maxSteps: number;
  /** Cross-turn memory — an episodic trace plus distilled semantic facts.
   *  Best-effort; needs an embedding provider. */
  memory: boolean;
  /** How far distilled facts reach. `thread` (default) keeps everything inside
   *  the conversation it was learned in; `agent` shares one pool across every
   *  thread, so the agent accumulates lasting knowledge — at the cost of facts
   *  learned from one person becoming visible to the next. */
  memoryScope?: AgentMemoryScope;
  active: boolean;
}

export type AgentMemoryScope = "thread" | "agent";

/** One durable fact an agent holds. Mirrors `/api/agents/:id/memory`. */
export interface AgentMemory {
  id: string;
  agentId: string;
  /** Conversation the fact was distilled from. */
  threadId: string | null;
  scope: AgentMemoryScope;
  content: string;
  /** False when the fact was stored with no embedding provider available — it's
   *  listable and forgettable, but not retrievable by similarity. */
  embedded: boolean;
  /** How many turns have retrieved this fact. */
  hits: number;
}

/** Create/update payload for an agent. */
export interface AgentInput {
  name: string;
  /** Mention handle. Derived from `name` when omitted; normalised and
   *  de-duplicated server-side. */
  handle?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  model?: string | null;
  effort?: "low" | "medium" | "high" | null;
  tools?: string[];
  maxSteps?: number;
  memory?: boolean;
  memoryScope?: AgentMemoryScope;
  active?: boolean;
}

/**
 * A conversation — a **room**, which may host several agents at once.
 *
 * `agentId` is the legacy single-agent pin (set on a thread opened against one
 * specific agent, null on a room); membership lives in `agentIds`.
 *
 * `routing` decides who answers a message that mentions nobody:
 * `mention` (nobody — the room is usable human-to-human), `default`
 * (`defaultAgentId` answers), or `auto` (a cheap router picks a participant).
 */
export interface AgentThread {
  id: string;
  tenantId?: string | null;
  agentId?: string | null;
  title?: string | null;
  status: "idle" | "running" | "error";
  routing?: AgentRoomRouting;
  defaultAgentId?: string | null;
  /** Participants. Present on room list/detail responses. */
  agentIds?: string[];
}

export type AgentRoomRouting = "mention" | "default" | "auto";

/** Create payload for a room. */
export interface AgentRoomInput {
  title?: string | null;
  agentIds?: string[];
  routing?: AgentRoomRouting;
  defaultAgentId?: string | null;
}

/**
 * One agent's turn — the unit of work AND the per-agent lock. Two agents can
 * answer the same room message at once; the same agent cannot run twice.
 */
export interface AgentRun {
  id: string;
  threadId: string;
  agentId: string;
  status: "queued" | "running" | "done" | "error";
  startedBy?: string | null;
  triggerMessageId?: string | null;
  error?: string | null;
}

/** One persisted message in a thread (user / assistant / tool). */
export interface AgentMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** Team member who asked. Threads are workspace-wide, so a transcript can
   *  mix authors; null on assistant/tool rows and on API-key-driven turns. */
  userId?: string | null;
  /** Which agent wrote an assistant/tool row — a room's transcript mixes
   *  several. Null on user rows. */
  agentId?: string | null;
  toolName?: string | null;
  toolArgs?: unknown;
  toolResult?: unknown;
}

/** A team member referenced by a transcript's `userId`s, returned alongside
 *  the messages so a client can render "who asked" without an extra lookup. */
export interface AgentThreadAuthor {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

/** One reason→act step the agent took during a turn. */
export interface AgentRunStep {
  thought?: string;
  tool: string;
  args: Record<string, unknown>;
  observation: string;
  isError: boolean;
}

/** Outcome of a single agent turn. */
export interface AgentRunResult {
  answer: string;
  steps: AgentRunStep[];
  stoppedReason: "final" | "max_steps" | "error";
  /** The persisted user message that triggered it — one row however many
   *  agents answered. */
  messageId?: string;
  /** Turns that were started, in responder order. */
  runs?: { runId: string; agentId: string }[];
  /** Agents that were asked to answer but were already mid-turn. */
  busy?: { agentId: string; runId: string }[];
  /** Every turn this message produced. The top-level `answer`/`steps` mirror
   *  the first, so single-agent callers need not look here. */
  turns?: AgentRunResult[];
}

/** What `send(..., { async: true })` returns: nothing has run yet. */
export interface AgentSendQueued {
  messageId: string;
  runs: { runId: string; agentId: string }[];
  busy: { agentId: string; runId: string }[];
}

/** AI agents (admin-scoped). Mirrors `/api/agents`. See `createClient`. */
export interface AgentsClient {
  /** List every agent in the active workspace. */
  list(): Promise<{ data: Agent[] }>;
  /** Fetch a single agent by id. */
  get(id: string): Promise<{ data: Agent }>;
  /** Create an agent scoped to the active workspace. */
  create(input: AgentInput): Promise<{ data: Agent }>;
  /** Partial update of an agent by id. */
  update(id: string, patch: Partial<AgentInput>): Promise<{ ok: boolean }>;
  /** Delete an agent by id. */
  delete(id: string): Promise<{ ok: boolean }>;
  /** List threads for an agent (most recently active first). */
  threads(agentId: string): Promise<{ data: AgentThread[] }>;
  /** Start a new conversation thread for an agent. */
  createThread(agentId: string, title?: string): Promise<{ data: AgentThread }>;
  /** Fetch a thread, its full message transcript, and the people who wrote it.
   *  Rooms additionally return their participants and any turns in flight. */
  thread(threadId: string): Promise<{
    data: {
      thread: AgentThread;
      messages: AgentMessage[];
      authors: AgentThreadAuthor[];
      agentIds?: string[];
      activeRuns?: AgentRun[];
    };
  }>;
  /** Delete a thread and its messages. */
  deleteThread(threadId: string): Promise<{ ok: boolean }>;
  /** Send a message and run whichever agents it wakes, to completion.
   *
   *  `agentIds` forces specific responders, bypassing the room's routing mode.
   *  `async: true` queues the turns instead and resolves as soon as they're
   *  accepted — watch `agent:thread:<id>` over realtime, or poll `getRun`. */
  send(
    threadId: string,
    message: string,
    opts?: { agentIds?: string[]; async?: false },
  ): Promise<{ data: AgentRunResult }>;
  send(
    threadId: string,
    message: string,
    opts: { agentIds?: string[]; async: true },
  ): Promise<{ data: AgentSendQueued }>;
  /** Every conversation in the workspace, newest activity first. */
  rooms(): Promise<{ data: AgentThread[] }>;
  /** Open a room. With no `agentIds` it starts empty. */
  createRoom(input?: AgentRoomInput): Promise<{ data: AgentThread }>;
  /** Rename a room or change how it routes unaddressed messages. */
  updateRoom(
    threadId: string,
    patch: Omit<AgentRoomInput, "agentIds">,
  ): Promise<{ ok: boolean }>;
  /** Add an agent to a room. Idempotent. */
  addRoomAgent(threadId: string, agentId: string): Promise<{ ok: boolean }>;
  /** Remove an agent from a room. */
  removeRoomAgent(threadId: string, agentId: string): Promise<{ ok: boolean }>;
  /** Poll one turn's status — for async sends without a realtime connection. */
  getRun(runId: string): Promise<{ data: AgentRun }>;
  /** The durable facts this agent has learned, newest first. These are
   *  distilled from past conversations — for the raw transcript use `thread`.
   *  `threadId` narrows to one conversation's pool. */
  memory(
    agentId: string,
    opts?: { threadId?: string; limit?: number },
  ): Promise<{ data: AgentMemory[]; meta?: { scope: AgentMemoryScope } }>;
  /** Teach the agent one durable fact directly, as a self-contained sentence.
   *  Deduped: re-teaching something it already knows resolves with
   *  `data: null` and `meta.deduped`. `threadId` is required while the agent's
   *  `memoryScope` is `thread`. */
  remember(
    agentId: string,
    content: string,
    opts?: { threadId?: string },
  ): Promise<{ data: AgentMemory | null; meta?: { deduped?: boolean } }>;
  /** Delete one remembered fact by id, from both the row store and the vector
   *  index — the agent stops retrieving it. */
  forget(agentId: string, memoryId: string): Promise<{ ok: boolean }>;
  /** Convenience: start a fresh thread and run one turn. Returns the result
   *  plus the new `threadId` so you can continue the conversation. */
  run(
    agentId: string,
    message: string,
    title?: string,
  ): Promise<{ data: AgentRunResult; threadId: string }>;
}

export const makeAgents = (core: ClientCore): AgentsClient => {
  // AI agents. Admin-scoped CRUD + thread management over `/api/agents`; `send`
  // runs one reason→act turn to completion, `run` is the new-thread shortcut.
  const agents: AgentsClient = {
    list: () => core.request<{ data: Agent[] }>("GET", "/api/agents"),
    get: (id: string) =>
      core.request<{ data: Agent }>("GET", `/api/agents/${encodeURIComponent(id)}`),
    create: (input: AgentInput) => core.request<{ data: Agent }>("POST", "/api/agents", input),
    update: (id: string, patch: Partial<AgentInput>) =>
      core.request<{ ok: boolean }>("PATCH", `/api/agents/${encodeURIComponent(id)}`, patch),
    delete: (id: string) =>
      core.request<{ ok: boolean }>("DELETE", `/api/agents/${encodeURIComponent(id)}`),
    threads: (agentId: string) =>
      core.request<{ data: AgentThread[] }>(
        "GET",
        `/api/agents/${encodeURIComponent(agentId)}/threads`,
      ),
    createThread: (agentId: string, title?: string) =>
      core.request<{ data: AgentThread }>(
        "POST",
        `/api/agents/${encodeURIComponent(agentId)}/threads`,
        title ? { title } : {},
      ),
    thread: (threadId: string) =>
      core.request<{
        data: {
          thread: AgentThread;
          messages: AgentMessage[];
          authors: AgentThreadAuthor[];
          agentIds?: string[];
          activeRuns?: AgentRun[];
        };
      }>("GET", `/api/agents/threads/${encodeURIComponent(threadId)}`),
    deleteThread: (threadId: string) =>
      core.request<{ ok: boolean }>(
        "DELETE",
        `/api/agents/threads/${encodeURIComponent(threadId)}`,
      ),
    send: ((
      threadId: string,
      message: string,
      opts?: { agentIds?: string[]; async?: boolean },
    ) =>
      core.request<{ data: AgentRunResult | AgentSendQueued }>(
        "POST",
        `/api/agents/threads/${encodeURIComponent(threadId)}/messages`,
        {
          message,
          ...(opts?.agentIds ? { agentIds: opts.agentIds } : {}),
          ...(opts?.async ? { async: true } : {}),
        },
      )) as AgentsClient["send"],
    run: async (agentId: string, message: string, title?: string) => {
      const { data: thread } = await agents.createThread(agentId, title);
      // The thread was opened against this agent, so it answers by default —
      // but pin it anyway so `run` means "this agent replies", full stop.
      const { data } = await agents.send(thread.id, message, { agentIds: [agentId] });
      return { data, threadId: thread.id };
    },
    rooms: () => core.request<{ data: AgentThread[] }>("GET", "/api/agents/threads"),
    createRoom: (input?: AgentRoomInput) =>
      core.request<{ data: AgentThread }>("POST", "/api/agents/threads", input ?? {}),
    updateRoom: (threadId: string, patch: Omit<AgentRoomInput, "agentIds">) =>
      core.request<{ ok: boolean }>(
        "PATCH",
        `/api/agents/threads/${encodeURIComponent(threadId)}`,
        patch,
      ),
    addRoomAgent: (threadId: string, agentId: string) =>
      core.request<{ ok: boolean }>(
        "POST",
        `/api/agents/threads/${encodeURIComponent(threadId)}/agents`,
        { agentId },
      ),
    removeRoomAgent: (threadId: string, agentId: string) =>
      core.request<{ ok: boolean }>(
        "DELETE",
        `/api/agents/threads/${encodeURIComponent(threadId)}/agents/${encodeURIComponent(agentId)}`,
      ),
    getRun: (runId: string) =>
      core.request<{ data: AgentRun }>(
        "GET",
        `/api/agents/runs/${encodeURIComponent(runId)}`,
      ),
    memory: (agentId: string, opts?: { threadId?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (opts?.threadId) qs.set("threadId", opts.threadId);
      if (opts?.limit != null) qs.set("limit", String(opts.limit));
      const suffix = qs.toString() ? `?${qs}` : "";
      return core.request<{ data: AgentMemory[]; meta?: { scope: AgentMemoryScope } }>(
        "GET",
        `/api/agents/${encodeURIComponent(agentId)}/memory${suffix}`,
      );
    },
    remember: (agentId: string, content: string, opts?: { threadId?: string }) =>
      core.request<{ data: AgentMemory | null; meta?: { deduped?: boolean } }>(
        "POST",
        `/api/agents/${encodeURIComponent(agentId)}/memory`,
        { content, ...(opts?.threadId ? { threadId: opts.threadId } : {}) },
      ),
    forget: (agentId: string, memoryId: string) =>
      core.request<{ ok: boolean }>(
        "DELETE",
        `/api/agents/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(memoryId)}`,
      ),
  };

  return agents;
};
