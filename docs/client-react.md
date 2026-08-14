---
title: React bindings
description: Session, live queries, optimistic writes and uploads as hooks — the twenty lines of useState each SDK primitive needed to become a component.
---

`backlex/react` turns the SDK's primitives into hooks. React is an optional
peer dependency; importing the subpath is what pulls it in.

```bash
npm i backlex react
```

```tsx
import { createClient } from "backlex";
import { useLiveQuery, useSession } from "backlex/react";

const backlex = createClient({ url: "", workspace: "acme", persist: true });

function Todos() {
  const { status, user, signOut } = useSession(backlex);
  const { data, loading } = useLiveQuery(backlex, "todos", { sort: "-created_at" });

  if (status === "unknown") return <Spinner />;
  if (status === "anonymous") return <SignIn />;
  return <List rows={data} loading={loading} onSignOut={signOut} />;
}
```

There is **no query cache here and no TanStack Query peer**, by design.
[`liveQuery`](./reactive-queries.md) already maintains an incrementally
consistent result array, so a second cache would be a second source of truth
for the same rows. What was missing was never caching — it was the twenty lines
of `useState` each primitive needed to become a component, which every
application wrote for itself.

## Sessions

### `persist` — the session survives a reload

```ts
const backlex = createClient({ url: "", workspace: "acme", persist: true });
```

That is the whole session story. The SDK captures the workspace session token
from sign-in and writes it through **the one place a token is ever written**,
so every capture path is covered: password sign-in, email OTP, magic link,
invite-accept, and sign-out. Restoring is automatic — the stored token is read
when the client is built.

The bug this removes is the one every hand-rolled version had: a helper called
after sign-in and forgotten after sign-**out**, so the next reload restores a
session the user just ended.

Keys are namespaced per workspace, so two workspaces served from one origin do
not share a session.

| Store | Survives | Reach for it when |
|---|---|---|
| `persist: true` | reloads and restarts | the ordinary browser case (`localStorage`, or memory where there is none) |
| `sessionStorageTokens()` | reloads, dies with the tab | a shared or public machine |
| `cookieTokens()` | reloads; **the server can read it** | a server needs the session during SSR |
| `memoryTokens()` | nothing | a server, where a token belongs to one request |

```ts
import { createClient, cookieTokens } from "backlex";

const backlex = createClient({
  url: "",
  workspace: "acme",
  persist: cookieTokens({ workspace: "acme" }),
});
```

:::caution[What persisting a token costs]
A session token kept anywhere script can read — `localStorage`,
`sessionStorage`, or a cookie written from the page — is readable by any script
that runs on the origin. Persisting a session and being immune to cross-site
scripting are not both available to a browser application, and none of these
stores can set `HttpOnly`, because a cookie the page can write is a cookie the
page can read.

What reduces the exposure is upstream: a strict Content-Security-Policy, and
short token lifetimes. For a session script must not be able to read at all,
use the cookie plane — sign in **without** `workspace` and let the server issue
an `HttpOnly` cookie, which is what the admin console and
`examples/nextjs-app` do.
:::

### `useSession`

```tsx
const { status, user, loading, error, refresh, signOut } = useSession(backlex);
```

`status` has three values because "we have not asked yet" is a real state:

| `status` | Means |
|---|---|
| `"unknown"` | the session has not been settled — render your splash, not your sign-in form |
| `"authenticated"` | `user` is populated |
| `"anonymous"` | nobody is signed in |

`loading` is `status === "unknown"`, which is exactly the `booting` flag
applications hand-roll.

Three behaviours worth knowing, because each is a decision rather than an
implementation detail:

- **A new token drops the status back to `"unknown"`** rather than claiming the
  previous user. Claiming it is how a UI shows the wrong name after an account
  switch.
- **A failed session probe is not a sign-out.** A dropped connection leaves the
  status where it was and reports `error`; the alternative signs people out of
  the interface while their session is perfectly good.
- **One probe serves the whole page.** Concurrent callers share one in-flight
  request, so six components asking for the session make one call.

The hook reads through `useSyncExternalStore`, so the state comes from the
client rather than a copy React owns. Two components cannot disagree, and
neither can a component and a plain `backlex.auth` call — a sign-in anywhere
moves all of them.

## Reading

### `useLiveQuery`

```tsx
const { data, loading, error, refreshing, refetch } =
  useLiveQuery(backlex, "todos", { filter: { done: { _eq: false } }, limit: 50 });
```

Runs the initial page, then keeps `data` consistent as rows change — from this
tab, another tab, another client, the SDK, or a flow. Re-subscribes when `slug`
or the (deep-equal) `opts` change; unsubscribes on unmount.

```tsx
useLiveQuery(backlex, "todos", opts, { keepPreviousData: true, enabled: ready });
```

- **`keepPreviousData` is off by default.** The default renders one query's
  rows only as that query's result. Turning it on means the rows on screen
  briefly belong to the *previous* query — right for a paginated table, wrong
  for a detail panel. `refreshing` tells you which you are looking at.
- **`enabled: false`** skips the query entirely, for a read that depends on
  something not ready yet.
- **`refetch()`** re-runs from scratch. It rebuilds the subscription, which is
  the only handle `liveQuery` offers — for a user pressing refresh, not for
  polling.

### `useList` and `useAggregate`

```tsx
const { data, total, loading, refetch } = useList(backlex, "orders", { limit: 20 });
const { data: rows } = useAggregate(backlex, "orders", { fn: "sum", field: "total" });
```

Plain reads, no subscription. Reach for these over `useLiveQuery` when the rows
do not change under the user — a report, a picker, a page of history: one
request instead of a request plus an open stream.

Both discard an answer that arrives out of order. Change a filter twice quickly
and the *first* request can resolve last; without that guard the screen shows a
result for a query nobody is asking any more.

## Writing

### `useItemMutation`

```tsx
const rows = useLiveQuery<Todo>(backlex, "todos", {});
const m = useItemMutation<Todo>(backlex, "todos");

return (
  <List
    rows={m.overlay(rows.data)}
    onAdd={(title) => m.create({ title })}
    onToggle={(t) => m.update(t.id, { done: !t.done })}
    onDelete={(t) => m.remove(t.id)}
  />
);
```

The change is on screen before the request finishes, and rolled back if the
write fails. `overlay` is applied by the component, so one view can show pending
rows while another does not, and neither hook has to know about the other.

**The overlay is held until the source array agrees**, not dropped when the
response lands. Dropping it on success re-renders the stored row — which is
still the old value until the change arrives — and that flash back to the old
value is the thing an optimistic update exists to remove. Pair it with
`useLiveQuery` and the realtime event retires the overlay; with `useList`, call
`refetch()`.

A failed write is rolled back **before** `error` is set, so a component that
renders on `error` never paints the failed change next to the message saying it
failed.

`useOptimistic` is the same overlay without the writes attached, for a mutation
you drive yourself.

### `useUpload`

```tsx
const { upload, progress, uploading, cancel } = useUpload(backlex);
await upload({ key: `avatars/${id}.png`, data: file });
```

A resumable (TUS) upload wired to the component's lifetime — an upload that
outlived its component would keep consuming bandwidth for a screen the user has
left. `cancel()` aborts; a resumable upload can be picked up again from the
server's offset with `backlex.storage.resumeUpload`.

## What is not here

The admin console does not use these hooks, and that is deliberate rather than
an omission — see [Architecture](./architecture.md#why-the-admin-keeps-its-own-client).

Which subsystems the SDK covers, and the written reason for each one it does
not, live in `apps/web/tests/sdk-surfaces.test.ts`. It is the canonical record:
a deferral there costs a sentence of reasoning and names the wave it is
revisited in, so an absence is a decision rather than a silence.
