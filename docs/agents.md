---
title: AI Agents
description: Reusable AI agents that reason, call your allow-listed tools, and answer — built on Backlex's MCP tool registry, vector memory, and realtime. A reason→act loop persisted as a replayable thread transcript; admin-authored and reachable over REST, the SDK, GraphQL, MCP, and the CLI.
---

Agents are reusable AI personas that **reason, call your tools, and answer** —
built on top of everything else Backlex already exposes. An agent is a named
definition (system prompt + model + a tool allow-list); a **thread** is one
conversation against it; sending a message runs one **turn** to completion.

Under the hood a turn is a reason→act loop: the model is asked to either call
one of the agent's allow-listed tools or finish. Each tool call is executed
through the **MCP tool registry** (`allTools`) via an in-process sub-fetch that
carries the caller's identity — so an agent can only ever do what the caller
could do (the permission DSL, tenant scoping, and per-key guards all apply).
Every step is persisted to the thread, so a thread is a complete, replayable
transcript.

## Concepts

| Concept | What it is | Table |
|---|---|---|
| **Agent** | A definition: name, system prompt, model, tool allow-list, `maxSteps`, `memory` | `agents` |
| **Thread** | One conversation against an agent (`idle` / `running` / `error`) | `agent_threads` |
| **Message** | One persisted turn step — `user`, `assistant`, or `tool` | `agent_messages` |

## Quick start (REST)

```bash
# 1. Create an agent with a read tool
curl -X POST $URL/api/agents -H 'content-type: application/json' --cookie "$C" -d '{
  "name": "Data buddy",
  "systemPrompt": "You answer questions about the workspace data. Be concise.",
  "tools": ["schema.list_collections", "collections.list", "collections.aggregate"],
  "maxSteps": 6
}'

# 2. Start a thread
curl -X POST $URL/api/agents/<agentId>/threads -d '{"title":"first chat"}' --cookie "$C"

# 3. Send a message — runs one turn to completion
curl -X POST $URL/api/agents/threads/<threadId>/messages \
  -H 'content-type: application/json' --cookie "$C" \
  -d '{"message":"How many orders were placed last month?"}'
# → { "data": { "answer": "...", "steps": [...], "stoppedReason": "final" } }
```

All `/api/agents` routes are **admin-only** (platform plane), scoped to the
active workspace.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/agents` | List agents |
| `POST` | `/api/agents` | Create an agent |
| `GET` | `/api/agents/{id}` | Get one |
| `PATCH` | `/api/agents/{id}` | Update |
| `DELETE` | `/api/agents/{id}` | Delete |
| `GET` | `/api/agents/{id}/threads` | List an agent's threads |
| `POST` | `/api/agents/{id}/threads` | Start a thread |
| `GET` | `/api/agents/threads/{threadId}` | Thread + full transcript |
| `DELETE` | `/api/agents/threads/{threadId}` | Delete a thread |
| `POST` | `/api/agents/threads/{threadId}/messages` | Send a message → run a turn |

A thread started without an explicit `title` is named after its opening prompt
(first line, clipped to 64 chars) on the first turn, so the admin's **History**
picker lists readable conversations instead of thread ids. Threads that predate
that behaviour get the same label derived on read in `GET /threads`.

## Definition fields

| Field | Default | Notes |
|---|---|---|
| `name` | — | Unique per workspace. |
| `description` | `null` | Free text. |
| `systemPrompt` | a generic helper persona | Shapes the agent's behaviour. |
| `model` | `anthropic/claude-haiku-4-5` | Gateway-prefixed id or bare Anthropic id (resolved by `callClaude`). |
| `tools` | `[]` | Allow-list of MCP tool names (validated against `allTools` at write time). An empty list = model-only, no data access. |
| `maxSteps` | `8` | Hard cap on reason→act iterations per turn (1–25). |
| `memory` | `false` | See [Memory](#memory). |
| `active` | `true` | — |

## Tools

An agent may call any tool whose name appears in its `tools` list, drawn from
the same registry the [MCP server](./mcp.md) exposes (`schema.*`,
`collections.*`, `vector.*`, `storage.*`, `flows.*`, …). Unknown names are
rejected when the agent is saved. Because tools run through the caller's
identity, an agent never escalates privileges — a read-only caller's agent can
only read.

## Memory

With `memory: true`, each turn's user message and final answer are embedded and
stored under a per-thread vector namespace (`agentmem:<threadId>`); on every new
turn the most relevant past snippets are retrieved and folded into the system
prompt. This gives cross-turn recall beyond the raw transcript (useful once a
thread grows long).

Memory is **best-effort**: it reuses the workspace embedding provider and
`EMBEDDING_DEFAULT_MODEL` (see [Vector search](./vector-search.md)). With no
embedding provider configured it silently no-ops — the agent still works.

## Live step streaming

While a turn runs, each step is published to the realtime channel
`agent:thread:<threadId>` as `agent.message` (the question, with its author) /
`agent.start` / `agent.step` / `agent.final` / `agent.error` events. Subscribe
with SSE to watch an agent think in real time:

```js
new EventSource(`/api/realtime/${encodeURIComponent("agent:thread:" + threadId)}/subscribe`,
  { withCredentials: true });
```

The admin **Agents** page uses exactly this to stream tool calls live in its
chat playground. (Streaming is best-effort; the final transcript is always
persisted regardless.)

The channel is **gated like the routes it mirrors**: signed-in, admin role, and
the thread must belong to your active workspace. The only payload a client may
publish there is a presence frame — `{ t: "hello" | "ping" | "typing" | "bye" }`
— whose identity is stamped server-side, so nobody can forge a turn event or
appear as a teammate.

## Team chat

Threads are **workspace-wide**, not per-person: anyone on the team with the
admin role sees the same conversations and can pick up any of them. That makes
a thread a shared artifact — one person asks the agent to dig through orders,
another reads the answer an hour later and asks the follow-up.

- **Attribution** — every `user` message records the team member who wrote it
  (`agent_messages.user_id`). `GET /api/agents/threads/{id}` returns the
  transcript plus an `authors` array (`id`, `name`, `email`, `image`) so a
  client can render bylines without an N+1 lookup. Assistant and tool rows stay
  unattributed, as do turns driven by an API key.
- **Live sync** — because every viewer subscribes to the thread channel, a
  teammate's question, its tool steps, and the final answer appear on your
  screen as they happen, not on your next refresh.
- **Presence** — who else has the thread open, and who is composing, rides the
  same channel (`typing` says *that* someone is typing, never *what*). The
  roster is derived client-side with a 45s TTL, like record collaboration.
- **One turn at a time** — a thread that's already `running` rejects a second
  turn (`409`), so the admin locks the composer and names who's holding it
  rather than letting you type into a doomed request.

## Other surfaces

The feature mirrors `flows` across every surface ([parity](./service-map.md)):

- **SDK** — `client.agents.{list,get,create,update,delete,threads,createThread,thread,deleteThread,send,run}`. `run(agentId, message)` starts a fresh thread and runs a turn in one call; `thread()` returns `{ thread, messages, authors }`.
- **GraphQL** — `agents` / `agent` queries; `createAgent` / `updateAgent` / `deleteAgent` / `runAgent` mutations.
- **MCP** — `agents.list`, `agents.get`, `agents.run` (so an external agent like Claude Desktop can drive a Backlex agent).
- **CLI** — `backlex agents <list|get|create|update|delete|threads|run>`. `backlex agents run <id> --message "…"` prints the answer.

## Notes & limits

- A turn runs **synchronously** inside the request that posts the message; the
  whole loop is bounded by `maxSteps` and the model's per-call token cap. A
  thread that is already `running` rejects a second concurrent turn (`409`).
- Requires an AI provider (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, or a
  workspace bring-your-own key, or the managed-cloud gateway). With none
  configured a turn returns `503 UNAVAILABLE` and the thread is marked `error`.
- **Deferred:** a durable, job-queue-backed async run path (enqueue a turn and
  poll/stream it) is not yet wired — the building blocks (`jobs` + the step
  loop) are in place, but reconstructing a tool-call identity for a detached
  worker needs more design. Synchronous runs are the supported path today.
