---
title: AI providers + model catalog
description: One registry declares every AI provider Backlex can generate with, one catalog lists the selectable models, and one resolution path (workspace → global → deployment) feeds Ask AI, agents, auto-translate and the ai.* tools.
---

Every AI feature in backlex — Ask AI, agents, the `ai.*` MCP tools, i18n
auto-translate, the Settings · AI "Test key" button — generates through **one**
resolution path. This page is that path.

Two files own it:

| File | Owns |
|---|---|
| `apps/web/src/server/services/ai-providers.ts` | The provider **registry** + the model **catalog** |
| `apps/web/src/server/services/ai-config.ts` | `resolveAiRuntime()` — turns stored config into `{ env, model, provider }` |

`apps/web/src/server/mcp/ai-client.ts` is the transport (Vercel AI Gateway or a
vendor SDK). It is not where provider knowledge lives.

## The registry

Each entry declares an id, a label, the secret/env key it needs, whether it is
reached through the gateway or directly, and its vendor namespace:

| id | transport | secret key (`ai_config.secrets`) | env var | reaches |
|---|---|---|---|---|
| `gateway` | gateway | `gatewayKey` | `AI_GATEWAY_API_KEY` | every vendor below, plus Mistral / Meta / xAI / … |
| `anthropic` | direct | `anthropicKey` | `ANTHROPIC_API_KEY` | Claude only |
| `openai` | direct | `openaiKey` | `OPENAI_API_KEY` | GPT only |
| `google` | direct | `googleKey` | `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini only |

Plus the sentinel `inherit`, which is the **absence** of a pick.

Adding a provider is one registry entry. The PUT enum, the secret-merge
allow-list, the `secretsSet` response, the admin picker and the model filter all
read from the registry — none of them name a provider.

### `OPENAI_API_KEY` is not auto-detected

The credential chain is:

1. `AI_PROVIDER` names a registry entry **and** that entry's env key is set →
   use it. This is the explicit opt-in, and what a workspace's bring-your-own
   pick sets internally.
2. Otherwise the historical sniff order: `AI_GATEWAY_API_KEY` →
   `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN`.

`OPENAI_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` are deliberately absent from
step 2. `OPENAI_API_KEY` is already set on many deployments purely for
**embeddings**; promoting it to the generation credential would silently reroute
and re-bill every AI feature, and on managed cloud would bypass the metered
platform gateway. To use it for generation, say so: set `AI_PROVIDER=openai`.

An `AI_PROVIDER` that names an unknown provider, or one whose key is missing,
falls through to step 2 rather than throwing. A bad config value degrades to the
deployment default; it never takes AI offline.

## Model ids are always provider-prefixed

Models are stored gateway-style (`anthropic/claude-haiku-4-5`) on every surface.
`resolveModelId(provider, model)` normalizes for the transport at call time:

- **gateway** — prefixed ids pass through. A **bare** id (no `/`) is a setting
  saved before the catalog existed, when bare meant Anthropic; it still gets the
  `anthropic/` prefix, so old rows keep working.
- **direct** — the vendor's own prefix is stripped. An id carrying a *different*
  vendor's prefix (`openai/gpt-5.6-sol` on a direct Anthropic key) cannot run,
  so it falls back to that provider's default instead of forwarding a
  guaranteed 404.

One canonical shape is what lets a workspace flip gateway ↔ direct without its
saved model becoming garbage.

It also constrains which spelling of an id the catalog may use. The gateway's
canonical Anthropic slugs use dots (`anthropic/claude-haiku-4.5`), but the
direct Anthropic API only accepts hyphens (`claude-haiku-4-5`) — and stripping a
prefix is all `resolveModelId` does. So the catalog stores the **hyphen** form,
which the gateway accepts as an alias and the direct API accepts natively. Any
Anthropic id added to the catalog has to satisfy both, not just the gateway.

## Resolution order

`resolveAiRuntime(ctx, tenantId)` walks **workspace row → global (`_global`) row
→ deployment default**, resolving the credential and the model *independently*:
a workspace that stored only a key still inherits the global default model, and
vice versa.

A row whose `provider` is `inherit`, is empty, names a provider this build
doesn't know, or has no decryptable secret does not dead-end — it falls through
to the next level. That is what makes `inherit` mean what it says.

When an override resolves, `applyAiOverride` overlays it: the chosen provider's
env key is set, `AI_PROVIDER` pins the pick, and every **other** generation
credential is blanked. "My key" must mean the workspace's key, never a silent
fallback to the operator's identity. `OPENAI_API_KEY` is the one exception — it
doubles as the embeddings credential, and `AI_PROVIDER` already makes the
generation pick unambiguous, so clearing it would break vector search as a side
effect of choosing a chat model.

## The catalog

`AI_MODELS` is a curated shortlist — id, label, vendor namespace, a one-line
cost/speed hint, and a tier (`flagship` / `balanced` / `fast`). It is **not**
exhaustive and isn't meant to be: `callClaude` passes whatever id it is given
straight through, and every surface keeps a "Custom…" escape hatch. A model
missing from the catalog is a UI inconvenience, never a hard block.

`GET /api/admin/ai-config` ships the registry and the catalog alongside the
stored config:

```jsonc
{
  "data": {
    "provider": "openai",
    "config": { "model": "openai/gpt-5.6-terra" },
    "secretsSet": { "gatewayKey": false, "anthropicKey": false,
                    "openaiKey": true, "googleKey": false },
    "providers": [ /* registry, minus anything secret */ ],
    "models": [ /* catalog */ ],
    "modelsByProvider": { "anthropic": ["anthropic/claude-opus-5", …] }
  }
}
```

`modelsByProvider` lets the admin re-filter the model dropdown the instant the
provider changes, with no second round-trip. Nothing in this payload contains
key material: `secretsSet` is a per-key boolean, and `envKey` is the *name* of a
variable an operator would set, not its value.

## Where each caller plugs in

| Caller | Model precedence |
|---|---|
| Ask AI (`routes/ai-ask.ts`) | request body → workspace config → `anthropic/claude-haiku-4-5` |
| Agents (`services/agents/runner.ts`) | agent row → workspace config → `anthropic/claude-sonnet-5` |
| Auto-translate (`services/i18n-translate.ts`) | workspace config → provider default |
| `ai.*` MCP tools (`mcp/http.ts`) | per-tool → provider default |
| Settings · AI "Test key" | workspace config — it proves the config that will actually run |

Auto-translate used to hard-code a direct Anthropic HTTP call, so a
gateway-only or OpenAI-only workspace was told to go fetch a second credential
for no technical reason. It now goes through `callClaude` like everything else.

## Tests

`apps/web/tests/ai-model-catalog.test.ts` covers the registry invariants, the
credential chain (including the `OPENAI_API_KEY` non-promotion), bare-id
normalization, cross-vendor fallback, the three-level resolution order, unknown
providers degrading instead of throwing, and the guarantee that no secret —
plaintext or ciphertext — appears in any response.
