---
title: Approvals
description: Park a row — or a whole flow — on a human decision, and keep the evidence.
---

Fourteen of the twenty-six schema templates carry a collection whose status goes
`pending → approved | rejected`: leave requests, expense claims, offer approvals,
vendor applications, engineering change orders, grant reports. Every one of them
used to be hand-rolled the same way — a status column, a notification, an admin
who edits the row — and the part that was always missing is the **evidence**: who
decided, in what capacity, when, from where, and why.

An approval request is that, plus one thing no status column can do: a flow can
**stop** on it.

## The shape

```
POST /api/admin/approvals
{
  "title": "Leave request — Ayşe Yılmaz, 3 days",
  "approvers": [
    { "email": "manager@acme.test", "role": "Line manager" },
    { "email": "hr@acme.test",      "role": "HR" }
  ],
  "policy": "all",
  "subject": { "collection": "leave_requests", "id": "3f2a…" },
  "summary": [
    { "label": "Dates",  "value": "12–14 March" },
    { "label": "Balance","value": "7 days remaining" }
  ],
  "writeBack": { "field": "status", "approvedValue": "approved", "rejectedValue": "rejected" }
}
```

Each approver gets their own emailed link. The response carries the plaintext
links **once** — only their SHA-256 is stored, exactly like a signing link or a
share link, so nothing can reproduce them afterwards.

## What settles it

`policy` decides, and the rules are not symmetric on purpose:

| `policy` | Approves when | Rejects when |
|---|---|---|
| `all` (default) | everyone approves | **one** person rejects |
| `any` | **one** person approves | everyone rejects |
| `quorum` (needs `quorum: N`) | N approve | so many reject that N is unreachable |

Under `all`, one rejection settles it immediately rather than waiting for the
rest: unanimity is already impossible, and continuing to collect answers only
wastes the other approvers' time. Under `any` a single refusal is deliberately
**not** a veto — that is the whole reason to ask several people.

`ordered: true` makes each link wait for the one above it. The next approver is
emailed when their turn actually arrives, and their token is minted then, so a
link cannot be used ahead of schedule.

## An expiry is a rejection

`expiresInHours` defaults to **72**. When it passes, the request settles as
`expired`, the `rejectedValue` is written back, and a waiting flow takes its
rejected branch.

That is deliberate. To everything downstream, a request nobody answered in time
is a request that was **not approved**, and making `expired` a third state would
force every consumer to handle a case that means exactly what `rejected` already
means.

Note the contrast with [e-signature](/docs/e-signature/), where expiry is *derived*
from the timestamp and nothing has to run. Here expiring has a **consequence** —
a parked flow has to be resumed — so it is written, by the scheduler tick.

## Stopping a flow on a person

`approval.request` is the only flow operation that suspends a run on something
other than the clock.

```json
[
  { "type": "approval.request",
    "title": "Refund {{ data.amount }} to {{ data.customer_email }}?",
    "approvers": "{{ data.approvers }}",
    "policy": "any",
    "writeBack": { "field": "status", "approvedValue": "approved", "rejectedValue": "declined" },
    "onRejected": [ { "type": "email", "to": "{{ data.customer_email }}", "subject": "About your refund" } ] },

  { "type": "payment.refund", "paymentId": "{{ data.payment_id }}" }
]
```

Everything **after** the step at the top level of the flow is the "once
approved" branch: it is checkpointed onto the request and resumed when the
decision lands — the same machinery a long `delay` uses to checkpoint onto
`scheduled_tasks`. `onRejected` is the other branch; a rejection or an expiry
runs it and the flow ends there. A **cancelled** request runs neither, because
the operator who withdrew it asked for neither.

On resume, `{{ $last }}` carries:

```json
{ "requestId": "…", "outcome": "approved", "decidedBy": { "email": "…", "name": "…", "role": "…" },
  "reason": "…", "approvals": 2, "rejections": 0 }
```

The subject defaults to the **triggering row** on an item-triggered flow, so
`subject` only has to be written out when it is something else.

### Where it cannot go

`approval.request` may not appear inside `onSuccess`, `onError`, `then` or
`else`. The continuation is "the rest of the flow", and there is no checkpoint
scope inside a nested branch — the runner would park the top-level remainder
while silently dropping the branch you wrote, and unlike a long `delay` it
cannot degrade to waiting inline.

Saving such a flow is **refused with a 422**, rather than leaving you to find
out at run time when the only symptom is a request nothing ever resumes. The
step's own `onRejected` is not a nesting and is always allowed.

A malformed step (approvers that resolve to nothing, a `quorum` policy with no
number) fails **before** the flow unwinds, so the author sees it in the run log
instead of the flow quietly ending.

## Settling happens exactly once

This is the property the whole design is built around, and the reason there are
**two** conditional updates rather than one:

1. The approver's own decision is guarded on their status — a double-tapped
   button or a retried POST cannot cast two votes toward a quorum.
2. The request's transition out of `pending` is guarded separately and confirmed
   by `RETURNING`. Only the caller that changes that row runs the write-back,
   sends the outcome mail and resumes the parked flow.

Without the second guard, an approval landing in the same instant as the expiry
tick would run the continuation **twice** — and a continuation is arbitrary
operator code: a second payment, a second provisioning call.

## Surfaces

| Surface | How |
|---|---|
| REST | `/api/admin/approvals` (admin), `/api/public/approve/:token` (the approver) |
| SDK | `client.approvals.list / get / create / cancel` |
| GraphQL | `approvalRequests`, `approvalRequest`, `createApprovalRequest`, `cancelApprovalRequest` |
| MCP | `approvals.list`, `approvals.get`, `approvals.request`, `approvals.cancel` |
| CLI | `backlex approvals <list\|get\|request\|cancel>` |

**No surface lets an admin decide on somebody's behalf.** Deciding is
authenticated by the approver's link and nothing else; an admin-authenticated
decision would also fire whatever the waiting flow does next.

**Only the CLI prints the links.** A terminal is the operator's own screen, and
`--no-send` exists precisely so you can paste a link somewhere yourself. An MCP
tool result is transcript that gets summarised, forwarded and stored, and a flow
op's result is readable by every op after it — so neither carries them.

## The approver's page

`/approve/:token` is public, unauthenticated and self-styled — somebody
answering one question from an email should not be loading the admin bundle's
theme. It shows the title, the frozen `summary`, their own position in the
order, and two buttons. A rejection requires a reason; a refusal with no reason
is the thing operators complain about.

The summary is rendered as **escaped text**, never as markup: it is row data
chosen by an operator, and the page has no reason to let it bring its own HTML.

The other approvers' addresses are never in the payload.

## The admin page

**Automation → Approvals** lists what is outstanding, sorted pending-first and
then by how soon each expires — the order for chasing answers. Opening one shows
the full decision trail: who was asked, who answered, when, from where and why.
The only action is **Withdraw**.

## Email

Three template keys, all with built-in fallbacks so nothing has to be seeded:
`approval_request`, `approval_approved`, `approval_rejected` (plus
`approval_expired` / `approval_cancelled`). Override any of them on the
**Email templates** page to change the wording.

Variables: `title`, `message`, `url`, `approver.{email,name,role}`, `summary`,
`expiresAt` on the invitation; `title`, `outcome`, `reason`, `approvers[]` on the
outcome.
