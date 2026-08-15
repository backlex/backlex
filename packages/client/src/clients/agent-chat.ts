import type { ClientCore } from "../core";

/**
 * Chatting with an agent as one of the workspace's OWN END USERS — the app-plane
 * half of agents, mounted at `/api/t/{workspace}/agents`.
 *
 * Deliberately a separate module from {@link AgentsClient}, which is the
 * operator's surface. The two are not the same service behind different gates:
 * an end user cannot create, configure or delete an agent, sees a strict subset
 * of one (never the system prompt, model or tool list), reads only the threads
 * they started, and gets back a reply rather than the agent's working-out.
 * Folding those into `agents` by flipping on the client's mode would give the
 * same method names different shapes and different rules, and half of them
 * would answer 403 — worse than no method at all.
 *
 * What makes this safe for an application to expose is that the end user
 * supplies only a MESSAGE. The operator writes the prompt, picks the tools and
 * opts the agent in per-agent (`appAccess`, off by default), so the
 * prompt-injection surface and the spend stay where the operator can see them.
 * The agent's tool calls run as the END USER, so it reads exactly what the
 * person talking to it may read.
 *
 * Needs an app-mode client — `createClient({ workspace: "acme" })` with an
 * end-user session. See `docs/agents.md`.
 */

/** An agent as an end user sees it: enough to render a picker, and no more.
 *  The system prompt in particular is what an attacker wants before trying to
 *  talk around it. */
export interface PublicAgent {
  id: string;
  name: string;
  handle: string | null;
  description: string | null;
}

/** One of my conversations. Never another end user's. */
export interface AgentChatThread {
  id: string;
  agentId: string | null;
  /** Derived from the opening prompt when it wasn't given one. */
  title: string | null;
  status: string;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
}

/** One line of a transcript. `tool` rows are the agent's working-out and are
 *  the operator's to review, so they never appear here. */
export interface AgentChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Which agent wrote it; null on the end user's own rows. */
  agentId: string | null;
  createdAt?: number | string | null;
}

/** One agent's answer to a turn. */
export interface AgentChatReply {
  agentId: string | null;
  content: string;
}

/** End-user agent chat. Mirrors `/api/t/{workspace}/agents`. See `createClient`. */
export interface AgentChatClient {
  /** The agents this workspace has opened to its end users. An agent that is
   *  inactive or not opted in is simply absent — never listed and refused. */
  agents(): Promise<{ data: PublicAgent[] }>;
  /** My conversations, on agents that are still open. */
  threads(): Promise<{ data: AgentChatThread[] }>;
  /** Start a conversation with one of them. */
  start(
    agentId: string,
    title?: string,
  ): Promise<{ data: { id: string; agentId: string; title: string | null } }>;
  /** The transcript of one of my conversations. */
  messages(threadId: string): Promise<{ data: AgentChatMessage[] }>;
  /** Say something, and get the reply. Runs the turn to completion. */
  send(threadId: string, message: string): Promise<{ data: { replies: AgentChatReply[] } }>;
}

export const makeAgentChat = (core: ClientCore): AgentChatClient => {
  // Resolved per call, not once at construction: every client assembles this
  // module, and an admin-mode client must not fail to be created just because
  // a surface it will never use has no workspace to point at.
  const base = (): string => {
    const ws = core.opts.workspace;
    if (!ws)
      throw new Error(
        "agentChat needs an app-mode client — pass `workspace` to createClient({ workspace: \"<slug>\" }). The operator's agent surface is `client.agents`.",
      );
    return `/api/t/${encodeURIComponent(ws)}/agents`;
  };
  const threadPath = (threadId: string, suffix = ""): string =>
    `${base()}/threads/${encodeURIComponent(threadId)}${suffix}`;

  return {
    agents: () => core.request<{ data: PublicAgent[] }>("GET", base()),
    threads: () => core.request<{ data: AgentChatThread[] }>("GET", `${base()}/threads`),
    start: (agentId, title) =>
      core.request<{ data: { id: string; agentId: string; title: string | null } }>(
        "POST",
        `${base()}/threads`,
        title === undefined ? { agentId } : { agentId, title },
      ),
    messages: (threadId) =>
      core.request<{ data: AgentChatMessage[] }>("GET", threadPath(threadId, "/messages")),
    send: (threadId, message) =>
      core.request<{ data: { replies: AgentChatReply[] } }>(
        "POST",
        threadPath(threadId, "/messages"),
        { message },
      ),
  };
};
