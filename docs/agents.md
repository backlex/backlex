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
| **Agent** | A definition: name, `handle`, system prompt, model, tool allow-list, `maxSteps`, `memory` | `agents` |
| **Room** | One conversation, which may host several agents | `agent_threads` |
| **Membership** | Which agents are in a room | `agent_thread_agents` |
| **Run** | One agent's turn — and the per-agent lock | `agent_runs` |
| **Message** | One persisted step — `user`, `assistant`, or `tool` | `agent_messages` |

A room is the unit of conversation; a run is the unit of work. One message can
start several runs (one per responding agent), and runs for **different** agents
proceed in parallel.

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
| `POST` | `/api/agents/{id}/threads` | Start a thread pinned to one agent |
| `GET` | `/api/agents/threads` | Every room in the workspace (with participants) |
| `POST` | `/api/agents/threads` | Open a room (`agentIds`, `routing`, `title`) |
| `GET` | `/api/agents/threads/{threadId}` | Room + transcript + participants + live runs |
| `PATCH` | `/api/agents/threads/{threadId}` | Rename / change routing / set the default agent |
| `POST` | `/api/agents/threads/{threadId}/agents` | Add an agent to a room |
| `DELETE` | `/api/agents/threads/{threadId}/agents/{agentId}` | Remove one |
| `DELETE` | `/api/agents/threads/{threadId}` | Delete a room |
| `POST` | `/api/agents/threads/{threadId}/messages` | Send a message → run whoever it wakes |
| `GET` | `/api/agents/runs/{runId}` | Poll one turn's status |

A thread started without an explicit `title` is named after its opening prompt
(first line, clipped to 64 chars) on the first turn, so the admin's **History**
picker lists readable conversations instead of thread ids. Threads that predate
that behaviour get the same label derived on read in `GET /threads`.

## Definition fields

| Field | Default | Notes |
|---|---|---|
| `name` | — | Unique per workspace. |
| `handle` | derived from `name` | The `@`-mention token, unique per workspace. Lowercased, whitespace as dashes; unicode letters are kept. Derived and de-duplicated server-side when omitted. |
| `description` | `null` | Free text. **Required in practice for `auto` routing** — it's the router's only input. |
| `systemPrompt` | a generic helper persona | Shapes the agent's behaviour. |
| `model` | `anthropic/claude-haiku-4-5` | Gateway-prefixed id or bare Anthropic id (resolved by `callClaude`). |
| `effort` | `null` | Reasoning effort — `low` / `medium` / `high`, or null for the provider default. See [Cost controls](#cost-controls). |
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
stored under a per-(thread, agent) vector namespace
(`agentmem:<threadId>:<agentId>` — scoped per agent so one persona in a room
never retrieves another's recollection); on every new
turn the most relevant past snippets are retrieved and folded into the system
prompt. This gives cross-turn recall beyond the raw transcript (useful once a
thread grows long).

Memory is **best-effort**: it reuses the workspace embedding provider and
`EMBEDDING_DEFAULT_MODEL` (see [Vector search](./vector-search.md)). With no
embedding provider configured it silently no-ops — the agent still works.

## Cost controls

A turn is a loop: every step re-sends the system prompt, the tool schemas, and
the transcript so far. That prefix is identical from one step to the next, which
is exactly what prompt caching is for.

- **Prompt caching is always on** and needs no configuration. Each request marks
  its last cacheable block, so the next step re-reads the whole prefix at ~0.1×
  of input price instead of paying full freight. The ~1.25× write premium pays
  for itself on the second call of any multi-step turn; a prefix below the
  model's minimum simply doesn't cache (no error). `POST .../messages` reports
  what it saved as `cachedTokens`, and the same number lands on the `agent.run`
  activity log entry.
- **`effort`** is the per-agent quality/cost dial: `low` means fewer thinking
  tokens and fewer, more consolidated tool calls; `high` (the provider default)
  is the most thorough. It is only sent to models that accept it — Opus 4.5+,
  Sonnet 4.6, Sonnet 5 and newer. On Haiku 4.5 or Sonnet 4.5 the parameter is a
  400, so backlex drops it rather than breaking the turn; the setting is stored
  either way and takes effect if you later switch the agent to a model that
  supports it.

Neither applies to the managed-cloud Workers AI path, which meters neurons
against the plan allowance instead of billing tokens.

## Live step streaming

While a turn runs, each step is published to the realtime channel
`agent:thread:<threadId>` as `agent.message` (the question, with its author) /
`agent.queued` / `agent.start` / `agent.step` / `agent.final` / `agent.error`
events. Every turn frame carries `agentId` + `runId`, since a room streams
several turns at once. Subscribe with SSE to watch an agent think in real time:

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

## Rooms (team chat)

Conversations are **workspace-wide**, not per-person: anyone with the admin role
sees the same rooms and can pick up any of them. A room is a shared artifact —
one person asks an agent to dig through orders, another reads the answer an hour
later and asks the follow-up. And a room can host **several agents at once**.

- **Attribution** — every `user` message records the team member who wrote it
  (`agent_messages.user_id`), and every assistant/tool row records the agent
  that produced it (`agent_messages.agent_id`). `GET /api/agents/threads/{id}`
  returns the transcript plus an `authors` array (`id`, `name`, `email`,
  `image`) and the room's `agentIds`, so a client renders both kinds of byline
  without an N+1 lookup.
- **Live sync** — every viewer subscribes to the room's channel, so a
  teammate's question, its tool steps, and the final answer appear on your
  screen as they happen, not on your next refresh.
- **Presence** — who else has the room open, and who is composing, rides the
  same channel (`typing` says *that* someone is typing, never *what*). The
  roster is derived client-side with a 45s TTL, like record collaboration.

### Who answers

| `routing` | A message that mentions nobody |
|---|---|
| `mention` (default for a new room) | Nobody. The room is a plain team thread until someone is addressed. |
| `default` | `default_agent_id` answers. This is what a thread opened against one agent does, so pre-rooms threads were migrated to it. With no default set and exactly one participant, that participant answers — a room set to this mode should never go silently mute. |
| `auto` | One extra, cheap model call reads the participants' `description`s and picks one (or none). Opt-in per room: it costs a round-trip and can pick wrong. |

An explicit `@handle` always wins over the routing mode, and **several mentions
run several agents**. Mentions resolve against the room's *active* participants;
an unknown handle is just prose.

> **Agents can't trigger each other.** Only a `user` message is ever routed, so
> an `@mention` inside an agent's own answer never starts a turn. The guarantee
> is structural — there is no chain depth to tune.

The surfaces that name an agent explicitly (`runAgent`, `agents.run`,
`backlex agents run`, and REST's `agentIds`) bypass routing — but only for
agents already in the room; naming an outsider is a `422`.

### One turn per agent, not per room

The lock lives on `agent_runs`, keyed `(thread_id, agent_id)` through a partial
unique index over `queued`/`running`. So:

- the **same** agent can't run twice in a room — a second message while it's
  working is a `409`;
- **different** agents can run at the same time, which is the whole point of a
  room. (The old lock was on the thread, so `@a @b` rejected one of them.)

A run heartbeats while it works; one that goes quiet for two minutes is treated
as a dead isolate and taken over rather than wedging the agent forever.

### Async turns

`POST …/messages` is **synchronous by default** — the turn runs inside the
request and the answer comes back in the response, exactly as before. Pass
`{"async": true}` and the turns are queued instead:

```jsonc
// 202 Accepted
{ "data": { "messageId": "…", "runs": [{ "runId": "…", "agentId": "…" }], "busy": [] } }
```

Watch the room's realtime channel (below) or poll `GET /api/agents/runs/{runId}`.
The admin's Chat page always sends async — three agents can't take turns holding
one HTTP response open. Async needs a signed-in user; an API key must send
synchronously (see the identity note below).

Execution is *enqueue + start inline*: a durable `agent.turn` job row is written,
then the turn begins immediately via `waitUntil`, so the common case has no queue
latency. The scheduled tick is only a safety net for a turn whose isolate died.

> **A turn is never replayed.** Tool calls have side effects, so the job is
> enqueued with `maxAttempts: 1` and the worker only runs a run it finds
> `queued` — anything else is failed and reported, not redone.

**Identity for a detached turn.** The promise that "an agent can only ever do
what its caller could" has to survive the response returning. The job carries the
enqueuing user's id (never client-supplied), and the worker mints a short-lived,
server-only agent-run token (HS256 over `AUTH_SECRET`) to re-enter the API with.
The token carries **no roles**: every sub-request resolves them from the database,
so a user suspended or demoted mid-turn loses access mid-turn. This is
deliberately not the system identity the job queue uses elsewhere, which would
escalate the agent past its caller.

## Other surfaces

The feature mirrors `flows` across every surface ([parity](./service-map.md)):

- **SDK** — `client.agents.{list,get,create,update,delete,threads,createThread,thread,deleteThread,send,run}` plus rooms: `{rooms,createRoom,updateRoom,addRoomAgent,removeRoomAgent,getRun}`. `send(id, msg, { async: true })` queues; `thread()` returns `{ thread, messages, authors, agentIds, activeRuns }`.
- **GraphQL** — `agents` / `agent` queries; `createAgent` / `updateAgent` / `deleteAgent` / `runAgent` mutations.
- **MCP** — `agents.list`, `agents.get`, `agents.run`, `agents.rooms_list`, `agents.room_send` (so an external agent like Claude Desktop can drive a Backlex agent, or post in a room).
- **CLI** — `backlex agents <list|get|create|update|delete|threads|run|rooms|say>`. `backlex agents run <id> --message "…"` prints the answer; `backlex agents say <roomId> --message "@handle …"` posts in a room.

## Notes & limits

- A turn is bounded by `maxSteps` and the model's per-call token cap. The same
  agent can't run twice in one room (`409`); different agents run in parallel.
- Requires an AI provider (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, a
  short-lived `ANTHROPIC_AUTH_TOKEN` — see [Ask AI](./ask-ai.md#requirements), or a
  workspace bring-your-own key, or the managed-cloud gateway). With none
  configured a turn returns `503 UNAVAILABLE` and the thread is marked `error`.
- Memory written before rooms existed lived under the bare `agentmem:<threadId>`
  namespace and is no longer retrieved. Memory is opt-in and best-effort, so
  this is a cold start rather than data loss.
