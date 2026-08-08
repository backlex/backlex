---
title: Organizations (teams)
description: The B2B grouping level inside a workspace — org membership, org-scoped roles, invitations, and the $org.id permission variable.
---

A workspace is *your* account. An **organization** is one of *your customers'*
accounts: the company an end-user signs into your app on behalf of. Every B2B
SaaS built on a backend eventually hand-rolls this — a company table, a
membership join, an invite flow, and a filter on every query. Backlex ships it.

Organizations live entirely on the **app plane** (see
[Auth planes](/docs/auth-planes/)). Their members are `app_users` — the
end-users of the app built on a workspace — never the control-plane operators
who run the dashboard.

## The two role layers

Both are called "roles" and they do completely different jobs. Keeping them
straight is the whole model:

| | Membership role | Org-scoped workspace role |
|---|---|---|
| Stored in | `app_org_members.role` | `app_org_member_roles` → `roles` |
| Vocabulary | `owner` / `admin` / `member` (fixed) | any workspace role you've defined |
| Governs | who may rename the org, invite, promote, remove | what data the member can read/write |
| Enforced by | `services/app-orgs.ts` | the permission resolver |

So a person can be an org `admin` (may invite colleagues) while holding only a
read-only workspace role inside that org — or the reverse. The membership role
never widens data access, and a workspace role never grants org administration.

The workspace `admin` role can **never** be bound as an org-scoped role. An org
owner administers their own org; they can't mint themselves a workspace admin.

## Which org is a request acting in?

The permission layer needs exactly one answer per request. It's resolved in
`services/app-orgs.ts::resolveOrgContext`, in this order:

1. **`X-Backlex-Org`** header (an org id *or* slug). It must name an org the
   caller belongs to — otherwise the request is **rejected with 403**, not
   quietly downgraded to a different org's data.
2. **The session's pinned org** — set by `POST /api/t/{slug}/orgs/set-active`
   with `{ "orgId": "…" }` (and cleared with `null`). Stored on
   `app_sessions.active_org_id`.
3. **The sole membership**, when the caller belongs to exactly one org. A
   single-org end-user never has to select anything.
4. **Nothing.** `$org.id` resolves to null, and an org-scoped rule matches no
   rows. This fails closed on purpose: with several orgs and no selection,
   picking one for the caller would leak whichever happened to sort first.

The membership list rides a per-isolate cache (the same TTL/LRU as the role and
tenant caches), so this costs one cached lookup per app-plane request. A
workspace with no organizations caches an empty list and is effectively free.

## Permission rules

Three variables become available (see [Permissions](/docs/permissions/)):

- `$org.id` — the active org
- `$org.role` — the caller's membership role in it
- `$user.orgs` — every org they belong to

The canonical B2B rule — a member sees only their own org's rows:

```jsonc
{ "collection": "tickets", "action": "read",
  "condition": { "org_id": { "_eq": "$org.id" } } }
```

Or, without requiring an active selection — everything across all their orgs:

```jsonc
{ "condition": { "org_id": { "_in": "$user.orgs" } } }
```

`$org.role` is a **value**, not a field — every DSL key is a column name, so it
belongs on the right-hand side of a comparison. It's for rows that store which
standing they require:

```jsonc
{ "collection": "org_documents", "action": "read",
  "condition": { "$and": [
    { "org_id":        { "_eq": "$org.id" } },
    { "required_role": { "_eq": "$org.role" } }
  ] } }
```

To gate an *action* on membership standing — "only owners and admins may
delete" — use an org-scoped workspace role instead: define a role, grant it the
`delete` permission, and bind it to those members via
`app_org_member_roles`. That's the layer built for it; the membership role
governs org administration only.

## Surfaces

Everything funnels through one service, so the guards below can't be bypassed
by picking a different surface.

### Admin (control plane) — `/api/app-orgs`

Admin-only, scoped to the active workspace.

| Method + path | Purpose |
|---|---|
| `GET /api/app-orgs` | List orgs with member counts (`?q=` filters name/slug) |
| `POST /api/app-orgs` | Create; `ownerAppUserId` seeds the first owner |
| `GET/PATCH/DELETE /api/app-orgs/{id}` | Read / rename+re-slug / delete (id or slug) |
| `GET/POST /api/app-orgs/{id}/members` | List / add a member |
| `PATCH/DELETE /api/app-orgs/{id}/members/{appUserId}` | Change role or in-org roles / remove |
| `GET/POST /api/app-orgs/{id}/invites` | List (`?pending=true`) / mint an invitation |
| `DELETE /api/app-orgs/{id}/invites/{inviteId}` | Revoke |

The admin UI for this is **Settings → Organizations**.

### End-user (app plane) — `/api/t/{slug}/orgs`

Authenticated as an app-plane identity (bearer token or the workspace's session
cookie). A control-plane admin session is deliberately not accepted here.

| Method + path | Who | Purpose |
|---|---|---|
| `GET /api/t/{slug}/orgs` | member | Orgs I belong to, plus the currently active one |
| `POST /api/t/{slug}/orgs` | any end-user | Start an org; the creator becomes its `owner` |
| `GET /api/t/{slug}/orgs/{id}` | member | One org |
| `PATCH`/`DELETE` `…/orgs/{id}` | owner | Rename / delete |
| `POST …/orgs/set-active` | member | Pin this session to an org (`{ "orgId": null }` clears) |
| `POST …/orgs/{id}/leave` | member | Leave |
| `GET …/orgs/{id}/members` | member | Who else is here |
| `PATCH`/`DELETE` `…/orgs/{id}/members/{appUserId}` | org admin | Change role + in-org roles / remove |
| `GET`/`POST` `…/orgs/{id}/invites` | org admin | List / send an invitation |
| `DELETE …/orgs/{id}/invites/{inviteId}` | org admin | Revoke |
| `POST …/orgs/invites/accept` | any end-user | Redeem `{ token }` |

Two rules bound what a member may do to another:

- Only an **owner** can grant ownership — an org admin can't promote themselves
  past their own ceiling.
- Nobody can act on a member who **outranks** them. An admin manages members and
  fellow admins; owners are above them and stay there. Acting on yourself is
  always allowed, which is how stepping down and leaving work.

Both live in the service, so no surface can route around them. A control-plane
admin holds no membership row and sits outside the order entirely — that's the
recovery path when an org has painted itself into a corner.

### SDK

One namespace, routed by client mode:

```ts
// End-user app (app mode)
const app = createClient({ url, workspace: "acme", token });
const { data: orgs } = await app.orgs.list();
app.orgs.use("northwind");                  // X-Backlex-Org on every request
await app.orgs.invite("northwind", { email: "sam@customer.com", role: "admin" });
await app.orgs.acceptInvite(token);

// Dashboard / server-side (admin mode)
const admin = createClient({ url, apiKey });
await admin.orgs.create({ name: "Northwind", ownerAppUserId });
await admin.orgs.addMember(orgId, { appUserId, roleIds: [analystRoleId] });
```

`orgs.use()` is the stateless option — it just sets the header, works with
access-JWT clients that have no session row, and can be passed up front as
`createClient({ org: "northwind" })`. `orgs.setActive()` is the stateful one; it
persists on the session so later requests need no header.

### GraphQL / MCP / CLI

- GraphQL: `appOrgs`, `appOrg`, `appOrgMembers`, `appOrgInvites` +
  `createAppOrg`, `updateAppOrg`, `deleteAppOrg`, `addAppOrgMember`,
  `updateAppOrgMember`, `removeAppOrgMember`, `inviteToAppOrg`,
  `revokeAppOrgInvite`. Admin-gated, same as REST.
- MCP: `app_orgs.list` / `.get` / `.create` / `.update` / `.delete` /
  `.members` / `.add_member` / `.update_member` / `.remove_member` /
  `.invites` / `.invite` / `.revoke_invite`.
- CLI: `bun backlex orgs <list|get|create|update|delete|members|add-member|update-member|remove-member|invites|invite|revoke-invite>`.

## Invitations

An org invitation is addressed to a **person**, not to whoever holds the link:
the accepting account's email must match the invited address, so a forwarded
token is useless. It also doesn't provision an account — the invitee needs an
`app_users` row first (self-signup, or the workspace-level
[end-user invite](/docs/auth-planes/)). Keeping the two flows separate is
deliberate: one creates an identity, the other grants a membership.

Invitations live 7 days. Accepted rows are kept with `accepted_at` set so an org
has an audit trail of how each member got in. The raw token is returned exactly
once — from the create call, and in the email. Listing invitations never
includes it, so an org admin can't replay somebody else's link.

## Invariants

- **An org always has at least one owner.** Demoting, removing or leaving as the
  last owner is a `VALIDATION` error; promote someone else first.
- **Slugs are unique per workspace.** A derived slug (from the name) is
  auto-suffixed on collision; an *explicit* one that's taken is a `CONFLICT` —
  silently renaming what the caller asked for would be worse than saying so.
- **Deleting an org** drops its memberships, in-org role bindings and
  invitations, and clears `active_org_id` on any session pinned to it. Done with
  explicit deletes rather than FK cascade so it behaves identically on
  SQLite/D1, which don't enforce foreign keys by default.
- **Deleting an end-user takes their seats with them.** Both account-removal
  paths — `DELETE /api/app-users/{id}` and [erasure](/docs/erasure/) — call
  `removeAppUserFromAllOrgs` first. A membership row orphaned by an account
  delete would be invisible *and* counted: every listing inner-joins
  `app_users`, so it vanishes from the UI while the owner count still sees it —
  a ghost owner satisfying the last-owner guard, letting the org's only real
  owner be removed. Pending invitations are left alone on purpose: they're
  addressed to an email, so someone who signs up again can still accept.
- **Cross-workspace isolation.** Every lookup is tenant-scoped, and an
  `app_users` row already belongs to exactly one workspace, so a slug or id from
  another workspace resolves to nothing.

## Where the code lives

| Piece | File |
|---|---|
| Service (all guards) | `apps/web/src/server/services/app-orgs.ts` |
| Admin routes | `apps/web/src/server/routes/app-orgs.ts` |
| End-user routes | `apps/web/src/server/routes/app-orgs-public.ts` |
| Active-org resolution | `apps/web/src/server/middleware/tenant.ts` |
| Org-scoped role merge | `apps/web/src/server/services/permissions.ts` |
| DSL variables | `packages/db/src/permission.ts` |
| Schema (both dialects) | `packages/db/src/{pg,sqlite}/schema.ts` |
| Admin UI | `apps/web/src/client/admin/pages/access/app-orgs.tsx` |
| Tests | `apps/web/tests/app-orgs.test.ts`, `app-orgs-surfaces.test.ts` |
