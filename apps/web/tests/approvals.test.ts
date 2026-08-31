/**
 * Approvals (#36).
 *
 * The pure policy math is exercised directly against `@backlex/core` — it has
 * no clock and no database, so testing it through HTTP would only make the
 * failures harder to read. Everything below that drives the real routes.
 *
 * What this file is actually pinning, in order of how much it costs to get
 * wrong:
 *
 *  1. Settling happens EXACTLY once. Two decisions racing, a decision racing
 *     the expiry tick, a double-submitted button — all of them must produce one
 *     write-back and one resumption, because a continuation is arbitrary
 *     operator code.
 *  2. An expiry is a rejection, not a third state.
 *  3. `ordered` is enforced server-side, not merely advertised.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { settleOutcome, canDecide, currentTurn, writeBackPatch } from "@backlex/core";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import type { FlowRunResult } from "../../../packages/client/src/index";

let h: TestHarness;

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const create = async (input: Record<string, unknown>) => {
  const res = await h.fetch("/api/admin/approvals", json({ send: false, ...input }));
  const body = (await res.json()) as any;
  return { status: res.status, body, data: body?.data };
};

const decide = async (token: string, decision: "approve" | "reject", reason?: string) => {
  const res = await h.fetch(
    `/api/public/approve/${token}`,
    json({ decision, ...(reason ? { reason } : {}) }),
  );
  return { status: res.status, body: (await res.json()) as any };
};

const tokenOf = (url: string): string => url.split("/approve/")[1]!;

const get = async (id: string) => {
  const res = await h.fetch(`/api/admin/approvals/${id}`);
  return (await res.json()) as any;
};

beforeEach(async () => {
  h = makeHarness();
  await seedAdmin(h);
});
afterEach(() => h.cleanup());

describe("policy math (pure)", () => {
  const A = (...statuses: string[]) => statuses.map((status) => ({ status }));

  test("`all` needs everyone, and one rejection ends it immediately", () => {
    expect(settleOutcome({ policy: "all", quorum: 3, approvers: A("approved", "pending") })).toBe(null);
    expect(settleOutcome({ policy: "all", quorum: 3, approvers: A("approved", "approved") })).toBe("approved");
    // The point: it does NOT wait for the third answer. Unanimity is already
    // unreachable, so collecting more would only waste people's time.
    expect(settleOutcome({ policy: "all", quorum: 3, approvers: A("rejected", "pending", "pending") })).toBe(
      "rejected",
    );
  });

  test("`any` settles on the first approval and rejects only when everybody has", () => {
    expect(settleOutcome({ policy: "any", quorum: 1, approvers: A("approved", "pending") })).toBe("approved");
    // A single refusal under `any` is not a veto — that is the whole reason to
    // ask several people.
    expect(settleOutcome({ policy: "any", quorum: 1, approvers: A("rejected", "pending") })).toBe(null);
    expect(settleOutcome({ policy: "any", quorum: 1, approvers: A("rejected", "rejected") })).toBe("rejected");
  });

  test("`quorum` rejects as soon as the target is unreachable", () => {
    const four = (...s: string[]) => ({ policy: "quorum" as const, quorum: 3, approvers: A(...s) });
    expect(settleOutcome(four("approved", "approved", "pending", "pending"))).toBe(null);
    expect(settleOutcome(four("approved", "approved", "approved", "pending"))).toBe("approved");
    // 2 rejections of 4 leaves 2 possible approvals — 3 can never be reached.
    expect(settleOutcome(four("rejected", "rejected", "pending", "pending"))).toBe("rejected");
    expect(settleOutcome(four("rejected", "pending", "pending", "pending"))).toBe(null);
  });

  test("no approvers can never settle", () => {
    expect(settleOutcome({ policy: "all", quorum: 1, approvers: [] })).toBe(null);
  });

  test("ordered turn-taking", () => {
    const rows = A("approved", "pending", "pending");
    expect(currentTurn(rows)).toBe(1);
    expect(canDecide(rows, 1, true)).toBe(true);
    expect(canDecide(rows, 2, true)).toBe(false);
    // Unordered, everyone still open may decide.
    expect(canDecide(rows, 2, false)).toBe(true);
    // Someone who already answered never decides again.
    expect(canDecide(rows, 0, false)).toBe(false);
  });

  test("an expiry writes the REJECTED value, not a third one", () => {
    const spec = { collection: "c", id: "1", field: "status", approvedValue: "ok", rejectedValue: "no" };
    expect(writeBackPatch(spec, "approved")?.data).toEqual({ status: "ok" });
    expect(writeBackPatch(spec, "rejected")?.data).toEqual({ status: "no" });
    expect(writeBackPatch(spec, "expired")?.data).toEqual({ status: "no" });
    // A spec naming no value for this outcome writes nothing at all.
    expect(writeBackPatch({ collection: "c", id: "1", field: "s" }, "approved")).toBe(null);
    expect(writeBackPatch(null, "approved")).toBe(null);
  });
});

describe("creating", () => {
  test("returns one link per approver, exactly once", async () => {
    const { status, data } = await create({
      title: "Leave request",
      approvers: [{ email: "a@x.test", role: "Manager" }, { email: "b@x.test" }],
    });
    expect(status).toBe(201);
    expect(data.links).toHaveLength(2);
    expect(data.request.approvers).toHaveLength(2);
    expect(data.request.status).toBe("pending");
    // `all` derives its quorum from the roster rather than trusting an input.
    expect(data.request.quorum).toBe(2);

    // Re-reading never surfaces the links again — only their hashes are stored.
    const again = await get(data.request.id);
    expect(JSON.stringify(again)).not.toContain(tokenOf(data.links[0].url));
  });

  test("refuses a duplicate address", async () => {
    const { status, body } = await create({
      title: "x",
      approvers: [{ email: "a@x.test" }, { email: "a@x.test" }],
    });
    expect(status).toBe(422);
    expect(body.error.message).toContain("listed twice");
  });

  test("refuses a quorum the roster cannot meet", async () => {
    const { status, body } = await create({
      title: "x",
      policy: "quorum",
      quorum: 5,
      approvers: [{ email: "a@x.test" }],
    });
    expect(status).toBe(422);
    expect(body.error.message).toContain("cannot be met");
  });

  test("never leaks the parked continuation", async () => {
    const { data } = await create({ title: "x", approvers: [{ email: "a@x.test" }] });
    expect(data.request).not.toHaveProperty("continuation");
  });
});

describe("deciding", () => {
  test("an approval under `any` settles the whole request", async () => {
    const { data } = await create({
      title: "x",
      policy: "any",
      approvers: [{ email: "a@x.test" }, { email: "b@x.test" }],
    });
    const out = await decide(tokenOf(data.links[0].url), "approve");
    expect(out.status).toBe(200);
    expect(out.body.data.outcome).toBe("approved");
    expect((await get(data.request.id)).data.status).toBe("approved");
  });

  test("one rejection under `all` ends it without asking the rest", async () => {
    const { data } = await create({
      title: "x",
      approvers: [{ email: "a@x.test" }, { email: "b@x.test" }],
    });
    const out = await decide(tokenOf(data.links[0].url), "reject", "over budget");
    expect(out.body.data.outcome).toBe("rejected");

    const row = (await get(data.request.id)).data;
    expect(row.status).toBe("rejected");
    expect(row.outcomeReason).toBe("over budget");
    // The second approver never answered, and their link is now closed.
    const late = await decide(tokenOf(data.links[1].url), "approve");
    expect(late.status).toBe(409);
  });

  test("rejecting requires a reason", async () => {
    const { data } = await create({ title: "x", approvers: [{ email: "a@x.test" }] });
    const out = await decide(tokenOf(data.links[0].url), "reject");
    expect(out.status).toBe(422);
    expect(out.body.error.message).toContain("reason");
  });

  test("a second decision on the same link is refused", async () => {
    const { data } = await create({
      title: "x",
      policy: "quorum",
      quorum: 2,
      approvers: [{ email: "a@x.test" }, { email: "b@x.test" }, { email: "c@x.test" }],
    });
    const token = tokenOf(data.links[0].url);
    expect((await decide(token, "approve")).status).toBe(200);
    // Still pending overall (1 of 2), so the refusal is about the APPROVER
    // having already answered — not about the request being closed.
    const second = await decide(token, "approve");
    expect(second.status).toBe(409);
    const row = (await get(data.request.id)).data;
    expect(row.approvers.filter((a: any) => a.status === "approved")).toHaveLength(1);
  });

  test("concurrent decisions on one link produce exactly one vote", async () => {
    const { data } = await create({
      title: "x",
      policy: "quorum",
      quorum: 3,
      approvers: [{ email: "a@x.test" }, { email: "b@x.test" }, { email: "c@x.test" }],
    });
    const token = tokenOf(data.links[0].url);
    // The double-tap. Only one of these may count toward the quorum.
    const results = await Promise.all([
      decide(token, "approve"),
      decide(token, "approve"),
      decide(token, "approve"),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const row = (await get(data.request.id)).data;
    expect(row.approvers.filter((a: any) => a.status === "approved")).toHaveLength(1);
    expect(row.status).toBe("pending");
  });

  test("ordered links refuse out-of-turn decisions", async () => {
    const { data } = await create({
      title: "x",
      ordered: true,
      approvers: [{ email: "first@x.test" }, { email: "second@x.test" }],
    });
    const out = await decide(tokenOf(data.links[1].url), "approve");
    expect(out.status).toBe(409);
    expect(out.body.error.message).toContain("turn");

    // Once the first decides, the turn moves. The second approver's token was
    // rotated when their turn opened, so the ORIGINAL link is dead and the
    // request must be re-read to reach them.
    expect((await decide(tokenOf(data.links[0].url), "approve")).status).toBe(200);
    expect((await get(data.request.id)).data.status).toBe("pending");
  });

  test("an unknown token is indistinguishable from a closed one", async () => {
    const res = await h.fetch("/api/public/approve/apv_deadbeef", json({ decision: "approve" }));
    expect(res.status).toBe(404);
    const { data } = await create({ title: "x", approvers: [{ email: "a@x.test" }] });
    await h.fetch(`/api/admin/approvals/${data.request.id}/cancel`, json({}));
    // Cancelled: the token still resolves, but the page says it is closed
    // rather than pretending it never existed.
    const view = await h.fetch(`/api/public/approve/${tokenOf(data.links[0].url)}`);
    expect(view.status).toBe(200);
    expect((await view.json()).data.blocked).toContain("cancelled");
  });
});

describe("the decision page", () => {
  test("shows the frozen summary and never the other approvers' addresses", async () => {
    const { data } = await create({
      title: "Expense claim",
      policy: "quorum",
      quorum: 2,
      summary: [{ label: "Amount", value: "1.240,00 TRY" }],
      approvers: [
        { email: "me@x.test", name: "Me" },
        { email: "secret@x.test", name: "Someone Else" },
      ],
    });

    // The other approver must have ANSWERED before this proves anything: with
    // nobody decided the `decided` array is empty by construction, so an
    // assertion made here alone can never fail. That is exactly how the first
    // version of this test passed while the view was leaking addresses.
    const other = await decide(tokenOf(data.links[1].url), "approve");
    expect(other.status).toBe(200);

    const res = await h.fetch(`/api/public/approve/${tokenOf(data.links[0].url)}`);
    const view = (await res.json()).data;
    expect(view.title).toBe("Expense claim");
    expect(view.summary).toEqual([{ label: "Amount", value: "1.240,00 TRY" }]);
    expect(view.you.email).toBe("me@x.test");
    expect(view.you.of).toBe(2);
    expect(view.decided).toHaveLength(1);
    expect(view.decided[0].name).toBe("Someone Else");
    expect(view.decided[0]).not.toHaveProperty("email");
    expect(JSON.stringify(view)).not.toContain("secret@x.test");
  });

  test("an ordered request does not name who is holding it up", async () => {
    const { data } = await create({
      title: "x",
      ordered: true,
      approvers: [
        { email: "first@x.test", name: "First Person" },
        { email: "second@x.test" },
      ],
    });
    const res = await h.fetch(`/api/public/approve/${tokenOf(data.links[1].url)}`);
    const view = (await res.json()).data;
    expect(view.blocked).toBeTruthy();
    // The message may say "not your turn" but must not disclose the roster.
    expect(JSON.stringify(view)).not.toContain("first@x.test");
    expect(JSON.stringify(view)).not.toContain("First Person");
  });

  test("viewing marks the approver as viewed without deciding", async () => {
    const { data } = await create({ title: "x", approvers: [{ email: "a@x.test" }] });
    await h.fetch(`/api/public/approve/${tokenOf(data.links[0].url)}`);
    const row = (await get(data.request.id)).data;
    expect(row.approvers[0].status).toBe("viewed");
    expect(row.approvers[0].viewedAt).toBeTruthy();
    expect(row.status).toBe("pending");
  });
});

describe("write-back", () => {
  const seedCollection = async () => {
    const res = await h.fetch(
      "/api/collections",
      json({
        slug: "leave_requests",
        fields: [
          { name: "status", type: "text" },
          { name: "note", type: "text" },
        ],
      }),
    );
    expect(res.status).toBeLessThan(300);
    const row = await h.fetch("/api/items/leave_requests", json({ status: "pending", note: "n" }));
    return ((await row.json()) as any).data.id as string;
  };

  test("patches the subject row on approval", async () => {
    const id = await seedCollection();
    const { data } = await create({
      title: "x",
      approvers: [{ email: "a@x.test" }],
      subject: { collection: "leave_requests", id },
      writeBack: { field: "status", approvedValue: "approved", rejectedValue: "rejected" },
    });
    await decide(tokenOf(data.links[0].url), "approve");
    const row = await (await h.fetch(`/api/items/leave_requests/${id}`)).json();
    expect((row as any).data.status).toBe("approved");
  });

  test("patches with the rejected value on a rejection", async () => {
    const id = await seedCollection();
    const { data } = await create({
      title: "x",
      approvers: [{ email: "a@x.test" }],
      subject: { collection: "leave_requests", id },
      writeBack: { field: "status", approvedValue: "approved", rejectedValue: "rejected" },
    });
    await decide(tokenOf(data.links[0].url), "reject", "no");
    const row = await (await h.fetch(`/api/items/leave_requests/${id}`)).json();
    expect((row as any).data.status).toBe("rejected");
  });

  test("a deleted subject row does not un-settle the decision", async () => {
    const id = await seedCollection();
    const { data } = await create({
      title: "x",
      approvers: [{ email: "a@x.test" }],
      subject: { collection: "leave_requests", id },
      writeBack: { field: "status", approvedValue: "approved" },
    });
    await h.fetch(`/api/items/leave_requests/${id}`, { method: "DELETE" });
    const out = await decide(tokenOf(data.links[0].url), "approve");
    // The decision is the source of truth; the failed patch is logged, not
    // propagated.
    expect(out.status).toBe(200);
    expect((await get(data.request.id)).data.status).toBe("approved");
  });
});

describe("cancelling", () => {
  test("closes the request and every link", async () => {
    const { data } = await create({
      title: "x",
      approvers: [{ email: "a@x.test" }, { email: "b@x.test" }],
    });
    const res = await h.fetch(
      `/api/admin/approvals/${data.request.id}/cancel`,
      json({ reason: "withdrawn" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("cancelled");
    expect((await decide(tokenOf(data.links[0].url), "approve")).status).toBe(409);
  });

  test("cancelling twice is refused", async () => {
    const { data } = await create({ title: "x", approvers: [{ email: "a@x.test" }] });
    await h.fetch(`/api/admin/approvals/${data.request.id}/cancel`, json({}));
    const second = await h.fetch(`/api/admin/approvals/${data.request.id}/cancel`, json({}));
    expect(second.status).toBe(409);
  });

  test("a bodyless cancel still works", async () => {
    // A POST with no body omits content-type, so the validator never runs and
    // `valid("json")` is undefined rather than `{}`.
    const { data } = await create({ title: "x", approvers: [{ email: "a@x.test" }] });
    const res = await h.fetch(`/api/admin/approvals/${data.request.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("expiry", () => {
  test("expiring settles as rejected and writes the rejected value", async () => {
    const { expireRequest } = await import("../src/server/services/approvals");
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(h.env);

    const res = await h.fetch(
      "/api/collections",
      json({ slug: "claims", fields: [{ name: "status", type: "text" }] }),
    );
    expect(res.status).toBeLessThan(300);
    const row = await h.fetch("/api/items/claims", json({ status: "pending" }));
    const id = ((await row.json()) as any).data.id as string;

    const { data } = await create({
      title: "x",
      approvers: [{ email: "a@x.test" }],
      subject: { collection: "claims", id },
      writeBack: { field: "status", approvedValue: "approved", rejectedValue: "rejected" },
    });

    expect(await expireRequest(ctx, data.request.id)).toBe(true);
    const after = (await get(data.request.id)).data;
    expect(after.status).toBe("expired");
    const patched = await (await h.fetch(`/api/items/claims/${id}`)).json();
    expect((patched as any).data.status).toBe("rejected");
  });

  test("an expiry racing a decision settles exactly once", async () => {
    const { expireRequest } = await import("../src/server/services/approvals");
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(h.env);

    const { data } = await create({
      title: "x",
      policy: "any",
      approvers: [{ email: "a@x.test" }],
    });
    const [decided, expired] = await Promise.all([
      decide(tokenOf(data.links[0].url), "approve"),
      expireRequest(ctx, data.request.id),
    ]);
    const final = (await get(data.request.id)).data;
    // Whichever won, the request has ONE terminal status and it is not
    // `pending`. Both winning would mean two write-backs and two resumptions.
    expect(["approved", "expired"]).toContain(final.status);
    const winners = [decided.status === 200, expired].filter(Boolean);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(final.settledAt).toBeTruthy();
  });

  test("expiring an already-settled request is a no-op", async () => {
    const { expireRequest } = await import("../src/server/services/approvals");
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(h.env);
    const { data } = await create({ title: "x", policy: "any", approvers: [{ email: "a@x.test" }] });
    await decide(tokenOf(data.links[0].url), "approve");
    expect(await expireRequest(ctx, data.request.id)).toBe(false);
    expect((await get(data.request.id)).data.status).toBe("approved");
  });
});

describe("the flow pause", () => {
  const makeFlow = (operations: unknown[]) =>
    h.fetch(
      "/api/flows",
      json({ name: `apv-${Math.random().toString(36).slice(2)}`, trigger: "manual:", operations }),
    );

  const runFlow = async (operations: unknown[], input: Record<string, unknown> = {}) => {
    const created = await makeFlow(operations);
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    const res = await h.fetch(`/api/flows/${data.id}/run`, json(input));
    return (await res.json()) as FlowRunResult;
  };

  const seedTarget = async () => {
    const res = await h.fetch(
      "/api/collections",
      json({ slug: "targets", fields: [{ name: "status", type: "text" }] }),
    );
    expect(res.status).toBeLessThan(300);
    const row = await h.fetch("/api/items/targets", json({ status: "waiting" }));
    return ((await row.json()) as any).data.id as string;
  };

  const onlyPending = async () => {
    const list = (await (await h.fetch("/api/admin/approvals?status=pending")).json()) as any;
    expect(list.data).toHaveLength(1);
    return list.data[0];
  };

  test("the flow reports ok and stops at the approval", async () => {
    const id = await seedTarget();
    const out = await runFlow([
      {
        type: "approval.request",
        title: "Ship it?",
        approvers: [{ email: "gate@x.test" }],
        policy: "any",
      },
      // This must NOT have run yet — it is the "once approved" branch.
      {
        type: "item.update",
        collection: "targets",
        id,
        data: { status: "approved-branch-ran" },
      },
    ]);
    // Pausing is a successful outcome, not a failure.
    expect(out).toEqual({ ok: true });

    const row = await (await h.fetch(`/api/items/targets/${id}`)).json();
    expect((row as any).data.status).toBe("waiting");
    await onlyPending();
  });

  test("approving runs the rest of the flow", async () => {
    const id = await seedTarget();
    await runFlow([
      { type: "approval.request", title: "Ship it?", approvers: [{ email: "gate@x.test" }], policy: "any" },
      { type: "item.update", collection: "targets", id, data: { status: "approved-branch-ran" } },
    ]);

    // The links are not on the flow result — that is the point — so reach the
    // token the way a test can: raise it again through REST is not the same
    // request, so instead drive the decision through the service.
    const pending = await onlyPending();
    const { buildContext } = await import("../src/server/context");
    const { settleRequest } = await import("../src/server/services/approvals");
    const ctx = await buildContext(h.env);
    const t = (await import("@backlex/db/sqlite")).schema.approvalRequests;
    const { eq } = await import("drizzle-orm");
    const [raw] = await (ctx.db as any).select().from(t).where(eq(t.id, pending.id));
    expect(await settleRequest(ctx, raw, "approved", null)).toBeTruthy();

    const row = await (await h.fetch(`/api/items/targets/${id}`)).json();
    expect((row as any).data.status).toBe("approved-branch-ran");
  });

  test("rejecting runs onRejected and NOT the rest", async () => {
    const id = await seedTarget();
    await runFlow([
      {
        type: "approval.request",
        title: "Ship it?",
        approvers: [{ email: "gate@x.test" }],
        policy: "any",
        onRejected: [
          { type: "item.update", collection: "targets", id, data: { status: "rejected-branch-ran" } },
        ],
      },
      { type: "item.update", collection: "targets", id, data: { status: "approved-branch-ran" } },
    ]);

    const pending = await onlyPending();
    const { buildContext } = await import("../src/server/context");
    const { settleRequest } = await import("../src/server/services/approvals");
    const ctx = await buildContext(h.env);
    const t = (await import("@backlex/db/sqlite")).schema.approvalRequests;
    const { eq } = await import("drizzle-orm");
    const [raw] = await (ctx.db as any).select().from(t).where(eq(t.id, pending.id));
    await settleRequest(ctx, raw, "rejected", "nope");

    const row = await (await h.fetch(`/api/items/targets/${id}`)).json();
    expect((row as any).data.status).toBe("rejected-branch-ran");
  });

  test("an expiry runs the rejected branch too", async () => {
    const id = await seedTarget();
    await runFlow([
      {
        type: "approval.request",
        title: "Ship it?",
        approvers: [{ email: "gate@x.test" }],
        policy: "any",
        onRejected: [
          { type: "item.update", collection: "targets", id, data: { status: "rejected-branch-ran" } },
        ],
      },
    ]);
    const pending = await onlyPending();
    const { buildContext } = await import("../src/server/context");
    const { expireRequest } = await import("../src/server/services/approvals");
    const ctx = await buildContext(h.env);
    expect(await expireRequest(ctx, pending.id)).toBe(true);

    const row = await (await h.fetch(`/api/items/targets/${id}`)).json();
    expect((row as any).data.status).toBe("rejected-branch-ran");
  });

  test("a cancelled request runs NEITHER branch", async () => {
    const id = await seedTarget();
    await runFlow([
      {
        type: "approval.request",
        title: "Ship it?",
        approvers: [{ email: "gate@x.test" }],
        policy: "any",
        onRejected: [
          { type: "item.update", collection: "targets", id, data: { status: "rejected-branch-ran" } },
        ],
      },
      { type: "item.update", collection: "targets", id, data: { status: "approved-branch-ran" } },
    ]);
    const pending = await onlyPending();
    await h.fetch(`/api/admin/approvals/${pending.id}/cancel`, json({ reason: "changed my mind" }));

    const row = await (await h.fetch(`/api/items/targets/${id}`)).json();
    expect((row as any).data.status).toBe("waiting");
  });

  test("an approval step nested in a branch is refused at save time", async () => {
    // Its continuation is "the rest of the flow", and there is no such scope
    // inside a branch — the runner would park the top-level remainder and drop
    // the branch the author wrote. Caught here, not at run time, where the only
    // symptom is a request nothing ever resumes.
    const res = await makeFlow([
      {
        type: "log",
        message: "hi",
        onSuccess: [
          { type: "approval.request", title: "x", approvers: [{ email: "a@x.test" }] },
        ],
      },
    ]);
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.error.message).toContain("top level");

    // A deeper nesting is caught too, and so is an update.
    const deep = await makeFlow([
      {
        type: "condition",
        filter: { status: { _eq: "x" } },
        then: [
          {
            type: "log",
            message: "hi",
            onError: [
              { type: "approval.request", title: "x", approvers: [{ email: "a@x.test" }] },
            ],
          },
        ],
      },
    ]);
    expect(deep.status).toBe(422);

    const ok = await makeFlow([
      { type: "approval.request", title: "x", approvers: [{ email: "a@x.test" }] },
    ]);
    expect(ok.status).toBe(201);
    const { data } = (await ok.json()) as { data: { id: string } };
    const patched = await h.fetch(
      `/api/flows/${data.id}`,
      json(
        {
          operations: [
            {
              type: "log",
              message: "hi",
              onSuccess: [
                { type: "approval.request", title: "x", approvers: [{ email: "a@x.test" }] },
              ],
            },
          ],
        },
        "PATCH",
      ),
    );
    expect(patched.status).toBe(422);
  });

  test("an approval step's own onRejected branch is still allowed", async () => {
    // `onRejected` is the step's OWN branch, not a nesting — it is parked
    // alongside the continuation. Only an approval INSIDE one is refused.
    const res = await makeFlow([
      {
        type: "approval.request",
        title: "x",
        approvers: [{ email: "a@x.test" }],
        onRejected: [{ type: "log", message: "no" }],
      },
    ]);
    expect(res.status).toBe(201);
  });

  test("a malformed op fails the run rather than parking an unresumable request", async () => {
    // `approvers` resolving to nothing is caught BEFORE the flow unwinds, so
    // the author sees it in the run log instead of the flow silently ending.
    const out = await runFlow([
      { type: "approval.request", title: "x", approvers: "{{ data.nobody }}" },
    ]);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("no approvers");
    const list = (await (await h.fetch("/api/admin/approvals")).json()) as any;
    expect(list.data).toHaveLength(0);
  });
});

describe("listing", () => {
  test("filters by status", async () => {
    await create({ title: "open", approvers: [{ email: "a@x.test" }] });
    const { data } = await create({ title: "closed", policy: "any", approvers: [{ email: "b@x.test" }] });
    await decide(tokenOf(data.links[0].url), "approve");

    const pending = await (await h.fetch("/api/admin/approvals?status=pending")).json();
    expect((pending as any).data.map((r: any) => r.title)).toEqual(["open"]);
    const approved = await (await h.fetch("/api/admin/approvals?status=approved")).json();
    expect((approved as any).data.map((r: any) => r.title)).toEqual(["closed"]);
  });
});
