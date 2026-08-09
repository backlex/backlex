---
title: Broadcast channels
description: Application-owned realtime pub/sub — chat rooms, cursors, notification buses — with pattern-matched authorization, presence, and a short retained history.
---

Every realtime channel backlex ships carries its own permission gate.
`items:<slug>` resolves a `read` permission and filters every row per
subscriber. `signal:items:<slug>` additionally demands that the permission be
unconditional. `collab:*` gates on the collection, `agent:thread:*` on the
thread's workspace, `collections` on the admin role.

Everything **else** — every channel name your application invents for a chat
room, a cursor feed, a notification bus — used to fall through to no gate at
all: no sign-in to subscribe, no sign-in to publish, no workspace scoping, no
retention. You could not put anything real on it.

Broadcast channels are that branch, given a rule.

:::caution[Behaviour change]
A free-form channel with **no matching rule is now refused** in both
directions. This closes a hole rather than opening a feature: those channels
were previously readable and writable by anyone who knew the name, signed in or
not. If an existing deployment depends on the old behaviour, set
`REALTIME_OPEN_CHANNELS=1` — which restores anonymous subscribe *and* anonymous
publish on every unmanaged channel name, and is exactly as unsafe as that
sounds.
:::

## A rule

```bash
backlex channels create \
  --name "Org feeds" \
  --pattern 'org:{org}:feed' \
  --subscribe 'roles:member' \
  --subscribe-condition '{"org":{"_eq":"$org.id"}}' \
  --publish 'none' \
  --replay --retention 24
```

That one rule authorizes every organization's feed. Nobody had to enumerate
organizations, and nobody can read another org's feed.

## Patterns

A pattern is colon-separated segments, each one of:

| Segment  | Matches                                        |
|----------|------------------------------------------------|
| `literal`| itself, exactly                                |
| `*`      | exactly one segment, whatever it is            |
| `{name}` | exactly one segment, **captured** as `name`    |
| `**`     | one or more remaining segments (last segment only) |

The grammar is closed on purpose. A closed grammar can be *decoded*, not merely
matched — and the captures are the point. `{name}` puts the segment's value
where the condition can read it, which is what turns "authorize every org's
feed" into one rule instead of one rule per org. A regex would match just as
well and capture nothing you could authorize on.

Channel names are **rejected, never normalized**: `a::b` is not `a:b`, because
two spellings of one name would resolve to two different rules.

The first segment must be a literal, and may not be one the managed channels
own (`items`, `signal`, `presence`, `collab`, `agent`, `collections`). A rule
there could never fire, and a rule that can never fire is worse than an
omission — you would configure it and believe it was running.

**Which rule applies when two match** is decided by specificity, not by which
was created first: `chat:lobby` beats `chat:{room}` beats `chat:*` beats
`chat:**`. Adding a narrow rule does what you expect to the broad one already
there.

## Access

`subscribe` and `publish` are separate answers, each one of:

| `access`        | Who                                                |
|-----------------|----------------------------------------------------|
| `none`          | nobody — a read-only channel is `publish: none`    |
| `public`        | anyone, including an unauthenticated caller        |
| `authenticated` | any caller with a session or token in the workspace|
| `roles`         | a caller holding one of `roles`                    |

Four answers, which is why the field is one object rather than a nullable roles
list beside a nullable condition: two nullable fields can spell three answers,
and the one they collapse is "nobody".

`condition` narrows any of them. It is an ordinary [permission
DSL](/docs/permissions) condition, with one twist: it is evaluated against the
pattern's **captures**, as if they were a row.

```json
{ "org": { "_eq": "$org.id" } }
```

on `org:{org}:feed` means "the org segment must be the org this request is
acting in". Every variable resolves the way it does anywhere else —
`$user.id`, `$user.email`, `$user.roles`, `$user.orgs`, `$org.id`, `$org.role`,
`$tenant.id`, `$now` — because this is the same evaluator realtime filtering
and the permission simulator use. There is no second rule language.

A stored rule that cannot be parsed means **nobody**, not everybody.

## Publishing

```ts
await backlex.channels.publish("org:acme:feed", { kind: "invoice.paid", id: 42 });
```

The body is `{ event?, data }`. `event` defaults to `"message"` and is a name
within the channel, not a permission. The sender identity is stamped
**server-side** from the session, so it cannot be forged — a client that puts a
`from` in the body is ignored, because the frame is rebuilt rather than
patched.

What subscribers receive:

```json
{ "kind": "message", "event": "invoice.paid", "data": { … },
  "from": { "id": "usr_…", "name": "ada@example.com" }, "at": 1786290000000 }
```

`data` is capped at 16 KB. A broadcast fans out to every subscriber and, with
replay on, is stored once per channel — a large payload is paid for twice.

## Subscribing

Subscribing is the ordinary realtime subscribe; nothing new:

```ts
const off = backlex.subscribe("org:acme:feed", (frame) => {
  if (frame.kind === "presence") updateRoster(frame);
  else render(frame.data);
});
```

On a deployment with `ABLY_API_KEY` and no held-stream transport, the channel is
reachable through `POST /api/realtime/ably-token`; the token's capability
mirrors the rule, so a caller who may only listen gets a subscribe-only token.

## Presence

Turn `presence` on and members may announce themselves:

```ts
await backlex.channels.presence("org:acme:feed", "hello", { cursor: 12 });
```

Frames are `hello`, `ping` (every ~15s) and `bye`, each carrying an optional
`state` object of up to 1 KB.

The roster is **derived by each client** from those frames with a TTL sweep —
there is no server-held membership. That is the protocol `collab:*` already
uses, and the reason is portability: a server-held roster works only on the two
transports that can hold mutable membership (in-process and Durable Object) and
would silently do nothing on the other two.

Presence frames are **never retained**. A replayed `hello` from yesterday is a
claim about the present that is false.

## Replay

Turn `replay` on and messages are kept for `retentionHours` (default 24, capped
at **72**).

```ts
let page = await backlex.channels.history("org:acme:feed");
while (page.cursor) {
  render(page.data);
  page = await backlex.channels.history("org:acme:feed", { since: page.cursor });
}
```

Oldest first, at most **25 per request**. The cursor is an opaque keyset over
`(created_at, id)` — a bare timestamp cursor would skip a message that shared a
millisecond with the one before it, or repeat one forever. Message ids are
time-ordered rather than random so that tiebreak is publish order, not a
shuffle.

Replay is a **reconnect aid, not an event store**, and the caps say so. A
workspace that wants history should write rows to a collection, where
permissions, search, export and backup already apply. Turning retention down
takes effect on the next read, not at the next prune.

## Debugging a refusal

A refused subscribe tells you it was refused and nothing more — deliberately,
since the reason would leak the rule set to whoever asked. Ask instead:

```bash
backlex channels explain 'org:acme:feed'
```

```
channel    org:acme:feed
rule       Org feeds (org:{org}:feed)
captured   org=acme
subscribe  allowed
publish    refused
why        Matched "Org feeds" (org:{org}:feed)
```

It answers for **your** identity, so it is safe to expose to a non-admin
debugging their own access. It requires a session: the answer names the rule,
and an anonymous caller could otherwise map a workspace's channel topology by
probing names.

## Surfaces

| Surface | Where |
|---|---|
| REST | `/api/admin/realtime-channels` (rules), `/api/realtime/{channel}/{publish,replay,explain}` |
| SDK | `backlex.channels.*`, plus `backlex.subscribe(channel, …)` |
| GraphQL | `broadcastChannels`, `channelExplain`, `channelHistory`, `create/update/deleteBroadcastChannel` |
| MCP | `channels.list/create/update/delete/explain/publish/history` |
| CLI | `backlex channels …` |

## What this deliberately is not

- **A message queue.** There is no delivery guarantee, no ack, no dead-letter.
  Use [jobs](/docs/jobs) for work that must happen.
- **An event store.** 72 hours, 25 per page. Use a collection.
- **A second permission system.** The condition language is the permission DSL,
  evaluated by the same function. If it gains an operator, so does this.
