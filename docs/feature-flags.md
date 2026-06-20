---
title: Feature flags
description: Toggle features and ship remote config without a deploy — per-workspace or global flags, with rollout-percentage and permission-DSL targeting, evaluated per caller and read by your apps at /api/flags.
---

Feature flags let you turn features on/off and ship **remote config** (any JSON
value) to your apps without a redeploy. Each flag is evaluated **per caller** —
with optional **rollout %** and **condition** targeting — and the resolved map is
served at `GET /api/flags`.

## Model

A flag is keyed by `(scope, key)`:

- **Global default** (`scope=global`, `tenant_id IS NULL`) — applies to every
  workspace.
- **Workspace override** (default scope) — a row for the active workspace with
  the same key wins over the global default.

Each flag carries:

| Field | Meaning |
|---|---|
| `enabled` | Master on/off. |
| `value` | Remote-config payload (any JSON) returned when the flag is on. |
| `rules` | Optional targeting: `{ condition?, rollout? }`. |
| `description` | Free text. |

A flag is **on for a caller** when `enabled` **and** its targeting passes.

### Targeting

- **`rollout`** — `0–100`. The caller is bucketed by a stable hash of
  `userId|key`, so a user stays in or out of the rollout across calls. `0` = off,
  `100` (or omitted) = everyone.
- **`condition`** — a [permission-DSL](/permissions/) condition matched against
  the **caller-context row** `{ user_id, email, roles, tenant_id }`. Examples:

  ```json
  { "roles": { "_contains": "beta" } }
  { "email": { "_eq": "founder@acme.com" } }
  { "tenant_id": { "_in": ["t_1", "t_2"] } }
  ```

  Both `condition` and `rollout` must pass when both are set.

## Reading flags (your apps)

```
GET /api/flags
→ { "data": { "new-checkout": { "enabled": true, "value": { "variant": "B" } }, … } }
```

The map only ever reflects what the caller is allowed to see — `value` is
withheld (`null`) when a flag is off. SDK:

```ts
const backlex = createClient({ url, apiKey });
await backlex.flags.all();                 // { key: { enabled, value } }
await backlex.flags.isEnabled("new-checkout");
await backlex.flags.get("new-checkout");   // the value payload
```

The SDK caches the map for the session; pass `{ refresh: true }` to re-fetch.

## Managing flags (admin)

Admin-gated CRUD at `/api/admin/feature-flags`:

```
GET    /api/admin/feature-flags
PUT    /api/admin/feature-flags/{key}            # workspace scope
PUT    /api/admin/feature-flags/{key}?scope=global
DELETE /api/admin/feature-flags/{key}[?scope=global]
```

```jsonc
// PUT body
{ "enabled": true, "value": { "variant": "B" }, "rules": { "rollout": 25 }, "description": "A/B checkout" }
```

Or use the **Feature flags** admin page (toggle, value, rollout, condition,
scope), or MCP: `flags.list`, `flags.set`, `flags.remove`.

## Notes

- Built on the same `app_settings`-style per-tenant store; flags live in their
  own `feature_flags` table (unique `(tenant_id, key)`).
- Evaluation is synchronous and cheap (one indexed read per request); no extra
  infrastructure.
- Targeting reuses the permission DSL engine, so any operator the DSL supports
  (`_eq`, `_in`, `_contains`, `$and`/`$or`, …) works in a flag condition.
