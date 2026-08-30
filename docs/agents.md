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
carries the caller's identity — so the **permission DSL and tenant scoping**
apply to every tool call, and roles are re-resolved from the database on each
sub-request rather than baked into the run token. Every step is persisted to the
thread, so a thread is a complete, replayable transcript.

:::caution[What bounds an agent]
A turn runs **as the user who started it**, with that user's roles — not as the
API key that made the request. Three things bound it, and they compose:

1. **The permission DSL and tenant scoping** of the starting user. Tool calls
   re-enter the API through an in-process sub-fetch, and roles are re-resolved
   from the database on every sub-request — so a user suspended or demoted
   mid-turn loses access mid-turn.
2. **The caller's MCP guards.** A tool allowlist or an `mcpReadOnly` flag —
   whether it sits on the API key, on an OAuth token's scopes (a token without
   `mcp:write` arrives read-only), or on one of the user's roles — narrows the
   agent too. The agent's catalog is filtered to what the caller may reach, and
   a call outside it comes back to the model as an error observation instead of
   running.
3. **The agent's own tool allowlist**, which only an admin can edit.
4. **A person, for the calls you name.** `approvalTools` holds tool-name globs
   (`collections.delete`, `collections.*`, `*` — the same grammar as an MCP
   allowlist) whose calls need someone's yes. See
   [Approval before a tool runs](#approval-before-a-tool-runs).

Skills do not widen any of these: a skill is instructions the agent reads, never
a capability it gains. A pasted `allowed-tools` key is ignored for exactly that
reason.

**Narrowing is announced, not silent.** When the caller's guards withhold some
of the agent's tools, the model is told how many and why, and asked to say
plainly which part it could not do. An agent that quietly answers from its own
knowledge because its whole toolset was filtered away reads exactly like an
agent that chose not to look anything up — which is the failure mode worth
designing against, since a key minted with the default `mcpTools: []`
(default-deny) can still reach the message route.

The guards are resolved where the credential that asked for the turn still
exists, and travel with the turn from there — for a background turn, on the job
payload, because it re-enters on a run token that carries no key. A queued turn
whose payload has no guards is **refused**, not run unguarded.

The practical consequence: granting a key `agents.run` delegates whatever that
agent's tool list can reach, **intersected** with what that key itself may
reach. A key scoped to `["agents.*"]` can start a turn but cannot use an agent
as a way around its own allowlist. Scope keys with that in mind, and still treat
an agent's tool list as the security decision it is. (`agents.run` is classified
`write`, so a read-only credential cannot start a turn at all.)

> Before this was enforced, an allowlist-scoped key holding `agents.run` could
> drive an agent whose tool list was broader — the guards were resolved for the
> MCP surface and then dropped on the way into the runner.
:::

## Approval before a tool runs

The three bounds above all answer *is this allowed at all*. This one says
**allowed, but not unattended** — the thing you want for a delete, a payment, or
anything a person would rather see before it happens.

```bash
curl -X POST $URL/api/agents -H 'content-type: application/json' --cookie "$C" -d '{
  "name": "Ops buddy",
  "tools": ["collections.list", "collections.delete"],
  "approvalTools": ["collections.delete"],
  "approvers": [{ "email": "ayse@example.com", "name": "Ayşe" }]
}'
```

When the agent reaches a gated tool it **does not run it**. It opens an
[approval request](./approvals.md), which reaches the approvers by email with
the tool name and the exact arguments, and the model is told plainly so the
answer says what is waiting on whom rather than pretending the work is done.

### Approve, then retry

Once someone approves, the same call — same tool, same arguments, same thread —
goes through on the next turn. The turn does **not** resume by itself, and that
is deliberate rather than unfinished:

- a flow parks its remaining operations in the request's `continuation` and is
  resumed by the settlement. Both the settlement path and the expiry tick can
  reach a parked continuation, which is why `services/approvals.ts` carries a
  note about running one twice. For a flow that is an operator's own oplist;
  for an agent it would be arbitrary tool calls — a second delete, a second
  payment;
- the turn already persists every step, so asking again costs one model call
  rather than a conversation.

The cost is that a person has to ask the agent again. The gain is that no
approval mechanism in this codebase can cause an operation to happen twice.

### What one approval covers

Exactly one `(thread, tool, arguments)` triple. The same tool against a
different row is a different decision and asks again; argument **order** is
normalised, so the same call does not look new because the model serialised it
differently. An approval is not consumed on use — the same call with the same
arguments in the same conversation is the same operation — and it expires on its
own through the approvals service.

### Two edges worth knowing

- **A gate with no approvers refuses.** If `approvalTools` matches and
  `approvers` is empty there is nobody who could grant it, so the call is
  refused rather than passed. "Configured for approval, ran unapproved" is the
  one outcome that must be impossible.
- **Patterns are not validated against the tool registry**, unlike `tools`.
  They are globs, and a pattern naming a tool that does not exist yet is a gate
  waiting for it rather than a typo. Over-matching fails safe — it asks a human
  about something harmless; under-matching would run something unattended.

Available on REST, GraphQL (`approvalTools`, `approvers`), the SDK and the CLI's
`agents create --data`. There is no MCP tool for agent CRUD, so nothing is owed
there.

## Skills

An agent already has a system prompt. A **skill** differs in two ways that
matter: it belongs to the **workspace** rather than to one agent, and it is paid
for only when used.

```bash
# Paste a SKILL.md written for any agent tool — that is the point of the format
curl -X POST $URL/api/agents/skills -H 'content-type: application/json' --cookie "$C" \
  -d "$(jq -Rs '{markdown: .}' < refunds/SKILL.md)"

# Attach it by name
curl -X PATCH $URL/api/agents/$AGENT -H 'content-type: application/json' --cookie "$C" \
  -d '{"skills": ["refunds"]}'
```

**Only the name and description reach the prompt.** The agent is given a
`skills_load` tool and calls it with a name when a description matches what it
is about to do. So a 3,000-word runbook costs two lines until the turn that
needs it — which is the whole economic argument for a skill over a longer
system prompt, and the reason the format was designed this way.

### The format is deliberately not ours

The columns are the [Agent Skills](https://code.claude.com/docs/en/skills) shape
— `name` + `description` in YAML frontmatter, markdown after it — so a tenant
can paste a skill written for Claude Code, Codex CLI, Cursor or Copilot and have
it work here. `POST /api/agents/skills` accepts either explicit fields or a raw
`markdown` string; explicit fields win, so the frontmatter can be overridden
without editing the file.

> **Frontmatter is read narrowly, on purpose.** Two scalar keys, no YAML engine.
> Anything else a real skill file carries is read past rather than obeyed —
> `allowed-tools` in particular is a capability grant, and honouring one that
> arrived in pasted text would let a skill widen what an agent may do. backlex
> ships its own skill for driving this API the same way; see
> [SDK & CLI](./sdk-and-cli.md).

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/agents/skills` | List the workspace's skills |
| `POST` | `/api/agents/skills` | Create one (`markdown`, or `name`/`description`/`body`) |
| `PATCH` | `/api/agents/skills/{id}` | Edit, or set `active: false` |
| `DELETE` | `/api/agents/skills/{id}` | Remove |

A name must be lowercase letters, digits and dashes — the model addresses a
skill by name, so it has to be typeable and unambiguous — and is unique per
workspace. A description is **required**: it is the only part the model sees, so
a skill without one is invisible rather than merely sparse.

An attached name that no longer resolves, or a skill set `active: false`, simply
stops being offered. That is the same contract a tool removed after the agent
was authored has, and it is why `skills` is not validated against existing rows
at write time — requiring the skill to exist first would make the order a
template seeds its data in load-bearing.

Available on REST, GraphQL (`skills`), the SDK type and the CLI's
`agents update --data`.

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
| `GET` | `/api/agents/{id}/memory` | The durable facts the agent holds (`?threadId=`, `?limit=`) |
| `POST` | `/api/agents/{id}/memory` | Teach it one fact directly |
| `DELETE` | `/api/agents/{id}/memory/{memoryId}` | Make it forget one |

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
| `memoryScope` | `"thread"` | `thread` \| `agent` — how far distilled facts reach. See [`memoryScope`](#memoryscope). |
| `active` | `true` | — |
| `appAccess` | `false` | Reachable by your application's own end users, not just operators. See [Chat from your own application](#chat-from-your-own-application). |

## Tools

An agent may call any tool whose name appears in its `tools` list, drawn from
the same registry the [MCP server](./mcp.md) exposes (`schema.*`,
`collections.*`, `vector.*`, `storage.*`, `flows.*`, …). Unknown names are
rejected when the agent is saved. Because tools run through the caller's
identity, an agent never escalates privileges — a read-only caller's agent can
only read.

## Memory

With `memory: true` an agent keeps two kinds of memory, because raw turns and
durable facts behave nothing alike.

### Episodic — what was said

Each turn's user message and final answer are embedded under a per-(thread,
agent) vector namespace (`agentep:<threadId>:<agentId>` — scoped per agent so
one persona in a room never retrieves another's recollection). On every new turn
the most relevant snippets are retrieved and folded into the system prompt,
giving cross-turn recall beyond the raw transcript.

Retrieval blends similarity with **recency**: in a conversation, "what we just
said" usually beats an equally-similar exchange from three weeks ago. The
recency term has a 14-day half-life and 30% of the blended weight, so it breaks
ties without overriding relevance. Episodic memory is always thread-scoped —
transcript snippets are the part most likely to carry something personal, and
they earn their keep inside a single conversation.

### Semantic — what is true

Every few turns a short, cheap LLM pass reads the transcript written since the
last one and extracts **durable facts** — stable preferences, decisions,
names and roles, constraints, configuration. Things still true after the
conversation ends. Each fact is stored as a row in `agent_memories` and
retrieved alongside the episodes under its own heading, so the model can weigh
"established" differently from "someone once said".

Facts get real rows rather than living only in the vector store, which buys
three things the vector adapter contract can't: listing, correcting, and
forgetting. New facts are deduped against the pool (cosine ≥ 0.93, or normalised
text when no embedding provider is available), the pool is capped at 60 facts
per scope (dropping never-retrieved ones first), and each row tracks how many
turns have actually retrieved it.

Distillation runs on the **job queue** (`agent.distill_memory`), not inside the
turn — the user already has their answer, and an extra LLM call shouldn't make
them wait for it. It's only enqueued once ~6 new turns have accumulated.

### `memoryScope`

How far the distilled facts reach:

| Value | Effect |
|---|---|
| `thread` (default) | Facts stay in the conversation they came from. Safe by construction — nothing said in one room resurfaces in another. |
| `agent` | One shared pool across every thread the agent takes part in, so it accumulates lasting knowledge about the workspace. |

`agent` is the point of semantic memory and also its risk: threads have
different human participants, so a fact learned from one person becomes visible
to the next. It's opt-in for exactly that reason.

Retrieval always filters on the agent's *current* scope, so flipping `thread` →
`agent` starts a fresh shared pool rather than retroactively broadcasting facts
learned while the agent was promised to stay inside one conversation.

### Reading and correcting

```bash
# What has it learned?
curl $APP/api/agents/$AGENT/memory
# Teach it something directly (deduped like a distilled fact)
curl -X POST $APP/api/agents/$AGENT/memory -H 'content-type: application/json' \
  -d '{"content":"Deploys go out on Thursdays.","threadId":"'$THREAD'"}'
# Make it forget
curl -X DELETE $APP/api/agents/$AGENT/memory/$MEMORY_ID
```

Also on the Agents page (**What it has learned**), the SDK
(`client.agents.memory` / `.remember` / `.forget`), GraphQL (`agentMemories`,
`rememberAgentFact`, `forgetAgentMemory`), MCP (`agents.memory_list` /
`memory_add` / `memory_forget`), and the CLI (`backlex agents memory …`).

There's deliberately no endpoint for episodic memory: it's a verbatim copy of
the transcript, which the thread endpoints already serve.

Memory is **best-effort**: it reuses the workspace embedding provider and
`EMBEDDING_DEFAULT_MODEL` (see [Vector search](./vector-search.md)). With no
embedding provider configured, episodic recall no-ops and semantic facts are
stored unindexed (`embedded: false`) and retrieved by recency — the agent still
works either way.

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

## Chat from your own application

Everything above is the **operator's** surface: `/api/agents` is admin-only, so
for most of this product's life AI was the one backlex primitive a customer's
own users could never touch. No in-product support bot, no assistant, unless you
proxied it yourself and put your own key behind it.

`/api/t/{workspace}/agents` is the end-user half. What makes it safe to open is
that the end user supplies only a **message** — you write the system prompt, you
pick the tools, and you opt each agent in one at a time. A general "generate"
endpoint would instead be free model access on your bill.

**Opt in per agent.** `appAccess` is `false` on every agent, including ones that
already exist: agents built when only operators could reach them may carry
internal prompts and privileged tools, so nothing was exposed by this surface
shipping. Turn it on in **Automation → Agents** (the *Open to end users* switch,
beside *Active*), or `PATCH /api/agents/{id}` with `{"appAccess": true}`. An
agent that is inactive or not opted in is **absent** from this surface rather
than refused — a private agent answers `404`, not `403`, because whether it
exists is not something an end user gets to confirm by guessing ids.

Three guards hold it up, and they are independent:

1. **The opt-in** above.
2. **Thread ownership** — a conversation is readable and writable only by the
   end user who started it. Revoking `appAccess` also closes the threads hanging
   off that agent: a conversation must not outlive the decision that allowed it.
   You still see every thread from the admin surface, which is what makes a
   support conversation reviewable.
3. **The turn runs as the end user.** The agent's tool calls re-enter the API
   carrying that person's identity, so the [permission DSL](./permissions.md)
   narrows the agent exactly as it narrows them. This is the property that makes
   tools safe to leave enabled — without it, "ask the agent" would be a way to
   read your neighbour's rows.

### Endpoints (app plane)

Every route needs a signed-in **workspace end user** (see
[auth planes](./auth-planes.md)); the path's workspace must match the session's.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/t/{workspace}/agents` | The agents opened to end users |
| `GET` | `/api/t/{workspace}/agents/threads` | My conversations |
| `POST` | `/api/t/{workspace}/agents/threads` | Start one (`agentId`, optional `title`) |
| `GET` | `/api/t/{workspace}/agents/threads/{threadId}/messages` | The transcript |
| `POST` | `/api/t/{workspace}/agents/threads/{threadId}/messages` | Say something → get the reply |

Two things are deliberately **not** on this surface. An agent is returned as
`{id, name, handle, description}` only — never the system prompt (which is
exactly what an attacker wants before trying to talk around it), the model, or
the tool list. And the transcript is the conversation alone: `tool` rows are the
agent's working-out, and reading them teaches an end user the shape of your
workspace's internals.

### From the SDK

```ts
import { createClient } from "backlex";

const backlex = createClient({ url: "https://api.example.com", workspace: "acme" });
await backlex.auth.signIn({ email, password });

const { data: agents } = await backlex.agentChat.agents();
const { data: thread } = await backlex.agentChat.start(agents[0].id);

const { data } = await backlex.agentChat.send(thread.id, "Where is my order?");
console.log(data.replies[0].content);

// Reopen it later
const { data: history } = await backlex.agentChat.messages(thread.id);
```

`agentChat` is app-mode only and throws if the client has no `workspace`, rather
than addressing `/api/t/undefined/...` and returning a 404 that reads like a
missing agent. It is a separate client from `client.agents` on purpose: an end
user sees a strict subset of an agent, reads only their own threads, and gets
back a reply rather than the reasoning — so folding both planes into one set of
method names would give them different shapes and different rules, and half of
them would answer 403.

There is no MCP tool, CLI command or GraphQL field for this surface, and that is
not an omission: those are operator tools, and an operator already has the
richer `/api/agents` for the same conversations.

Turns are metered like any other — the runner carries the workspace's meter, so
an end user's turn lands in `usage_counters` exactly like an operator's. See
[usage metering](./usage-metering.md#ai-generation).

## Other surfaces

The feature mirrors `flows` across every surface ([parity](./service-map.md)):

- **SDK** — `client.agents.{list,get,create,update,delete,threads,createThread,thread,deleteThread,send,run}` plus rooms: `{rooms,createRoom,updateRoom,addRoomAgent,removeRoomAgent,getRun}` and memory: `{memory,remember,forget}`. `send(id, msg, { async: true })` queues; `thread()` returns `{ thread, messages, authors, agentIds, activeRuns }`. Your application's own end users get a separate client — `client.agentChat.{agents,threads,start,messages,send}`, see [Chat from your own application](#chat-from-your-own-application).
- **GraphQL** — `agents` / `agent` / `agentMemories` queries; `createAgent` / `updateAgent` / `deleteAgent` / `runAgent` / `rememberAgentFact` / `forgetAgentMemory` mutations.
- **MCP** — `agents.list`, `agents.get`, `agents.run`, `agents.rooms_list`, `agents.room_send`, `agents.memory_list`, `agents.memory_add`, `agents.memory_forget` (so an external agent like Claude Desktop can drive a Backlex agent, post in a room, or inspect what one has learned).
- **CLI** — `backlex agents <list|get|create|update|delete|threads|run|rooms|say|memory>`. `backlex agents run <id> --message "…"` prints the answer; `backlex agents say <roomId> --message "@handle …"` posts in a room; `backlex agents memory <id>` lists its facts.

## Notes & limits

- A turn is bounded by `maxSteps` and the model's per-call token cap. The same
  agent can't run twice in one room (`409`); different agents run in parallel.
- Requires an AI provider (`AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, a
  short-lived `ANTHROPIC_AUTH_TOKEN` — see [Ask AI](./ask-ai.md#requirements), or a
  workspace bring-your-own key, or the managed-cloud gateway). With none
  configured a turn returns `503 UNAVAILABLE` and the thread is marked `error`.
- An agent left on **Default** now follows the workspace's default model from
  Settings · AI before falling back to `anthropic/claude-sonnet-5`, so switching
  the workspace to OpenAI or Gemini moves the agents with it. Full resolution
  order in [AI providers + model catalog](./ai-providers.md).
- Episodic memory written before the episodic/semantic split lived under the
  `agentmem:*` namespaces and is no longer retrieved. Memory is opt-in and
  best-effort, so this is a cold start rather than data loss.
- Distillation costs one extra (cheap, `effort: low`) LLM call per ~6 turns, on
  the job queue. It's skipped entirely when no AI provider is configured — the
  facts you add by hand still work.
