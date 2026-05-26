---
title: Ask AI (admin page)
description: Natural-language MCP-tool dispatch from the workeros admin. Translate prompts into reviewable tool calls, approve or auto-run reads, and watch the audit log fill itself.
---

The **Ask AI** page in the workeros admin (sidebar → *Ask AI*) lets an
operator type a question, get back a single proposed MCP tool call with
JSON arguments, edit the arguments if the model picked imperfectly, and
then execute. Reads (`collections.list`, `vector.search`, `schema.*`, …)
can auto-run; writes and destructive operations always wait for an
explicit click.

It is the same surface Claude Desktop sees through `/mcp` — just driven
by the admin's own session instead of a personal access key, so every
permission check, allowlist, and audit row works identically.

## What it does

The page ships four tabs over the same backing data:

| Tab | Source | Role |
|---|---|---|
| **Ask** | `POST /api/admin/ai/plan` + `POST /api/admin/ai/run` | The natural-language planner — see the table below. |
| **Tools** | `POST /api/admin/mcp` (`tools/list`) + `PATCH /api/api-keys/<id>/mcp-guards` | The catalog of every MCP tool the workspace exposes, with a Try button per row and a per-key guards editor in the right rail. |
| **Runs** | `GET /api/activity?action=mcp.&limit=200` | A filterable table of every MCP run (Ask AI or external) with CSV export. |
| **Connect** | (no backend) | Renders Claude Desktop / Cursor / curl install snippets for the selected API key. |

The Ask tab itself is a two-hop flow:

| Step | Endpoint | Behaviour |
|---|---|---|
| 1. Plan | `POST /api/admin/ai/plan` | The configured model (default `anthropic/claude-haiku-4-5`) is given the prompt + a short whitelist of read-leaning tools and asked for `{rationale, tool, args}` as fenced JSON. The route validates and returns it — nothing is executed. |
| 2. Run  | `POST /api/admin/ai/run`  | The named tool is dispatched against the **in-process** Hono app — same path Claude Desktop's MCP call would take. One row lands in `activity` (success and failure) so the Recent Runs panel and the existing logs page both see it. |

Splitting `plan` from `run` is deliberate. The MCP `ai.query` tool plans
**and** executes in one shot, which is right for an external agent that
already trusts the model; it's wrong for an admin reviewing a write. The
page renders the proposed JSON, lets the operator edit it (the JSON-args
panel doubles as the source of truth), and only POSTs `/run` after a
click — except when "auto-run reads" is on and the proposed tool matches
`/^(collections\.list|collections\.read|storage\.list|vector\.search|schema\.)/`.

### Tools tab

`POST /api/admin/mcp` with `{ method: "tools/list" }` returns every tool
the dispatcher exposes plus the `kind` (`read` / `write` / `destruct`)
and `adminOnly` hints introduced in this phase (see
[MCP](./mcp.md#tool-kind-metadata)). Rows are grouped by namespace
prefix (`collections.*`, `schema.*`, …) and filtered by a single search
input that matches against name + description. The **Try** button per
row POSTs `/api/admin/ai/run` with `{ tool, args: {} }` so callers can
sanity-check a tool with empty arguments without leaving the page; the
result lands in `activity` and shows up under **Runs**.

The right rail is a per-key guards editor. The top dropdown lists the
signed-in user's live `pak_*` keys (revoked / expired filtered
client-side). Flipping **Read-only mode** PATCHes
`/api/api-keys/<id>/mcp-guards` immediately; the **Customize…** button
opens the existing per-tool checkbox modal
([`McpKeyModal`](../apps/web/src/client/components/mcp-key-modal.tsx))
pre-filled with the selected key's allowlist instead of re-implementing
the grid here.

### Runs tab

Loads up to 200 rows from `GET /api/activity?action=mcp.&limit=200`
(filtered server-side so we don't paginate through unrelated audit
rows) and maps each through `mapActivityToRun` — the same helper the
Recent Runs side panel on the Ask tab uses. Status derivation:

- `ok` whenever `response.ok === true`
- `blocked` when the error string contains `read-only` / `allowlist` /
  `mcp_read_only` (a per-key MCP guard rejected the call)
- `denied` for any other failure

The header filter chips (All / Success / Review / Denied) gate the
visible rows with live counts. **Export CSV** uses the
`client/lib/csv-export.ts` helper introduced in this phase and writes a
`mcp-runs.csv` with `when, tool, query, status, rows, durationMs,
error` columns. There is **no tokens column in v1** — `activity.response`
doesn't carry token usage today; a future PR will write `response.usage`
from `/api/admin/ai/run` and add the column.

### Connect tab

Builds a Claude Desktop / Cursor / curl install snippet for the
selected `pak_*` key using the pure builders in
`client/lib/mcp-snippets.ts` (shared with the per-key modal). The MCP
URL defaults to `${window.location.origin}/mcp`. The plaintext secret
is unrecoverable after key creation, so the snippet renders the secret
as `pak_<prefix>_••••••••` for every existing key — admins paste the
config, then replace the masked secret with the one they captured at
creation time. The **Copy** button writes the snippet to the clipboard
and toasts; the right-rail card surfaces the OAuth-flow roadmap (no
backend behind that).

## Requirements

- An AI provider credential on the workeros deployment. workeros routes
  through [Vercel AI Gateway](https://ai-gateway.vercel.sh) by default —
  set `AI_GATEWAY_API_KEY` and one key reaches Anthropic, OpenAI, Google,
  and every other gateway-supported provider. The UI ships provider-
  prefixed model ids (`anthropic/claude-haiku-4-5`, `openai/gpt-5`,
  `google/gemini-2.5-pro`).
- **Legacy fallback:** when `AI_GATEWAY_API_KEY` is unset but
  `ANTHROPIC_API_KEY` is set, the client falls back to the direct
  Anthropic provider (Claude only). The page silently strips the
  `anthropic/` prefix from any selected model. Workspaces that already
  ship `ANTHROPIC_API_KEY` keep working with no change.
- Without **either** key, `/plan` returns `503 UNAVAILABLE` with a clear
  message — the same pattern every `ai.*` MCP tool uses (see
  `apps/web/src/server/mcp/ai-client.ts`).
- The signed-in user must hold the system `admin` role. Non-admins get a
  hard `403 FORBIDDEN` on both endpoints.

## Why log via the route, not the dispatcher

The MCP dispatcher (`apps/web/src/server/mcp/dispatch.ts`) handles **all**
identities — cookie sessions, personal access keys, app-plane bearer
tokens. Most of them don't map to a user id in the way the `activity`
table wants. Logging there would either dilute the table with
key-attributed rows that have no `user_id` or require a separate audit
table.

The Ask AI page is admin-only, browser-only, and always carries a user
id, so its `/run` handler writes the audit row directly. Action prefix
is `mcp.<tool>` (e.g. `mcp.collections.list`), payload is `{tool, args}`,
response is `{ok, rowCount, error?}`, `durationMs` is the wall-clock
span the dispatch took. The Recent Runs panel queries the same table
with `?action=mcp.&limit=10`.

If a future Phase 2 needs runs from API keys too, the right move is a
new dispatcher hook with its own table — not retrofitting `activity`.

## Supported models

The dropdown ships **11 models across 6 providers**, all routed through
Vercel AI Gateway when `AI_GATEWAY_API_KEY` is set. Defaults are biased
toward Anthropic because the JSON-constrained `/plan` system prompt is
most reliable on Claude; other providers are exposed for users who
prefer them or want to swap on cost / context / latency.

| Provider | Model id | Notes |
|---|---|---|
| Anthropic | `anthropic/claude-opus-4-7` | Highest reasoning, slower, ~3× cost |
| Anthropic | `anthropic/claude-sonnet-4-6` | Balanced — recommended for most queries |
| Anthropic | `anthropic/claude-haiku-4-5` | Fast, cheap, routine reads — **default** |
| OpenAI    | `openai/gpt-5`               | OpenAI flagship; comparable to Opus |
| Google    | `google/gemini-2.5-pro`      | Long context, multimodal |
| xAI       | `xai/grok-4.3`               | xAI flagship, 1M context |
| xAI       | `xai/grok-build-0.1`         | Optimized for code agents, cheap |
| DeepSeek  | `deepseek/deepseek-v4-pro`   | Strong reasoning, 1M context, low cost |
| DeepSeek  | `deepseek/deepseek-v4-flash` | Fast, very cheap, routine reads |
| Alibaba   | `alibaba/qwen3.7-max`        | Qwen flagship, 1M context, strong multilingual |
| Alibaba   | `alibaba/qwen3.6-plus`       | Qwen mid-tier, balanced pricing |

Adding more from the [Vercel AI Gateway
catalog](https://vercel.com/ai-gateway/models) is a one-line edit to the
`MODELS` array in `apps/web/src/client/admin/pages/ask-ai.tsx` — the
picker groups by the `provider/` prefix automatically, so no UI code
change is needed. **Meta/Llama is not in the gateway catalog as of this
writing** and is not exposed in the picker.

Legacy `ANTHROPIC_API_KEY` mode silently strips the `anthropic/` prefix
and only the three Anthropic rows above work; selecting an OpenAI /
Google / xAI / DeepSeek / Alibaba model returns `503 UNAVAILABLE` until
`AI_GATEWAY_API_KEY` is set.

## Model picker + preferences

The model dropdown defaults to `anthropic/claude-haiku-4-5` and persists
the choice to `localStorage` under `workeros.askai.model`. Pre-gateway
values stored as bare ids (`claude-haiku-4-5`) are silently rewritten on
read so the dropdown highlights the right row on first paint. The
"auto-run reads" toggle persists to `workeros.askai.autoRun` (`"1"` /
`"0"`). Neither is workspace-scoped — they are per-browser, which is
what an operator expects from a power-user surface.

## Where to look in code

| File | Role |
|---|---|
| `apps/web/src/server/routes/ai-ask.ts` | The two POST handlers + the read-leaning whitelist. |
| `apps/web/src/client/admin/pages/ask-ai.tsx` | The page. Replaces the design's mock `planForPrompt` with the two real fetches. |
| `apps/web/tests/ai-ask.test.ts` | Contract tests — UNAVAILABLE branch, unknown tool, happy-path run + activity row, 401/403 gates. |

See also: [MCP (Model Context Protocol)](./mcp.md) for the underlying
tool roster and per-key guards.
