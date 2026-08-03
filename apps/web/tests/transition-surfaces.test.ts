/**
 * Multi-surface parity for status transitions.
 *
 * A lifecycle that only one surface enforces is not a lifecycle — it is a
 * suggestion the admin UI makes and the API ignores. So the gate here is that
 * every path that can write the column refuses the same move, and every path
 * that can read the row offers the same set of next values.
 *
 * The one that has broken on every previous field feature is GraphQL: its
 * create / update resolvers hand-build their own SQL rather than calling
 * `performCreate` / `performUpdate`, so a check added to the REST write core
 * ships on exactly one surface until it is repeated there. Rollups, sequences,
 * geo and money each found that the hard way; this file is the version of that
 * lesson that fails before shipping.
 *
 * The CLI is checked structurally rather than by spawning a shell — it is a
 * thin argv parser over the SDK, and what rots is a subcommand disappearing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../../../packages/client/src/index";
import { itemsPublishTools } from "../src/server/mcp/tools/items-publish";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const gql = async (query: string, variables?: unknown) =>
  (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
    data?: Record<string, any>;
    errors?: { message: string }[];
  };

const sdk = () => createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

const mcp = (name: string, args: Record<string, unknown>) => {
  const tool = itemsPublishTools.find((x) => x.name === name)!;
  return tool.handler(args, {
    fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init),
  } as never);
};

const TICKETS = "surf_tickets";

const newTicket = async (status = "new"): Promise<string> =>
  (
    await (
      await h.fetch(`/api/items/${TICKETS}`, json({ title: crypto.randomUUID().slice(0, 8), status }))
    ).json()
  ).data.id as string;

const readStatus = async (id: string): Promise<string> =>
  (await (await h.fetch(`/api/items/${TICKETS}/${id}`)).json()).data.status as string;

describe("status transitions — multi-surface parity", () => {
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/collections",
      json({
        slug: TICKETS,
        fields: [
          { name: "title", type: "text" },
          { name: "close_note", type: "text" },
          {
            name: "status",
            type: "text",
            interface: "dropdown",
            options: {
              choices: [{ value: "new" }, { value: "open" }, { value: "closed" }],
            },
            transitions: {
              initial: ["new"],
              allow: [
                { from: "new", to: "open", label: "Take" },
                { from: "open", to: "closed", requires: ["close_note"], label: "Close" },
                { from: "closed", to: "open", label: "Reopen" },
              ],
            },
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("REST refuses the illegal move and accepts the legal one", async () => {
    const id = await newTicket();
    const skip = await h.fetch(`/api/items/${TICKETS}/${id}`, json({ status: "closed" }, "PATCH"));
    expect(skip.status).toBe(422);
    expect(await readStatus(id)).toBe("new");
    expect((await h.fetch(`/api/items/${TICKETS}/${id}`, json({ status: "open" }, "PATCH"))).status).toBe(200);
  });

  test("GraphQL refuses the same move — its resolver hand-builds its own SQL", async () => {
    const created = await gql(
      `mutation ($data: SurfTicketsInput!) { createSurfTickets(data: $data) { id } }`,
      { data: { title: "gql", status: "new" } },
    );
    expect(created.errors ?? []).toEqual([]);
    const id = created.data!.createSurfTickets.id as string;

    const skip = await gql(
      `mutation ($id: ID!, $data: SurfTicketsInput!) { updateSurfTickets(id: $id, data: $data) { id } }`,
      { id, data: { status: "closed" } },
    );
    expect(skip.errors?.[0]?.message ?? "").toContain("Cannot move");
    expect(await readStatus(id)).toBe("new");

    const ok = await gql(
      `mutation ($id: ID!, $data: SurfTicketsInput!) { updateSurfTickets(id: $id, data: $data) { id } }`,
      { id, data: { status: "open" } },
    );
    expect(ok.errors ?? []).toEqual([]);
    expect(await readStatus(id)).toBe("open");
  });

  test("GraphQL enforces `initial` on create", async () => {
    const bad = await gql(
      `mutation ($data: SurfTicketsInput!) { createSurfTickets(data: $data) { id } }`,
      { data: { title: "bad", status: "closed" } },
    );
    expect(bad.errors?.[0]?.message ?? "").toContain("starting value");
  });

  test("GraphQL `requires` sees the same-mutation value", async () => {
    const id = await newTicket();
    await h.fetch(`/api/items/${TICKETS}/${id}`, json({ status: "open" }, "PATCH"));
    const bare = await gql(
      `mutation ($id: ID!, $data: SurfTicketsInput!) { updateSurfTickets(id: $id, data: $data) { id } }`,
      { id, data: { status: "closed" } },
    );
    expect(bare.errors?.[0]?.message ?? "").toContain("requires");
    const together = await gql(
      `mutation ($id: ID!, $data: SurfTicketsInput!) { updateSurfTickets(id: $id, data: $data) { id } }`,
      { id, data: { status: "closed", closeNote: "fixed" } },
    );
    expect(together.errors ?? []).toEqual([]);
    expect(await readStatus(id)).toBe("closed");
  });

  test("the batch endpoint refuses per-op, and an atomic batch rolls the whole thing back", async () => {
    const id = await newTicket();
    const res = await h.fetch(
      `/api/items/${TICKETS}/batch`,
      json({
        operations: [
          { op: "update", id, data: { title: "renamed" } },
          { op: "update", id, data: { status: "closed" } },
        ],
        atomic: true,
      }),
    );
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("Cannot move");
    // Atomic: the legal first op must not survive the illegal second one.
    const row = (await (await h.fetch(`/api/items/${TICKETS}/${id}`)).json()).data;
    expect(row.title).not.toBe("renamed");
    expect(row.status).toBe("new");
  });

  test("CSV import refuses a row whose move is illegal", async () => {
    const id = await newTicket();
    const csv = `id,status\n${id},closed\n`;
    const res = await h.fetch(`/api/items/${TICKETS}/import?mode=upsert`, {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: csv,
    });
    const out = (await res.json()) as any;
    const report = out.data ?? out;
    expect(report.failed ?? report.errors?.length ?? 0).toBeGreaterThan(0);
    expect(await readStatus(id)).toBe("new");
  });

  test("the SDK reads the same offer the REST endpoint does", async () => {
    const id = await newTicket();
    const { data } = await sdk().from(TICKETS).transitions(id);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ field: "status", current: "new", terminal: false });
    expect(data[0]!.moves.map((m) => m.to)).toEqual(["open"]);
    expect(data[0]!.moves[0]).toMatchObject({ allowed: true, label: "Take" });
  });

  test("the SDK's write path is refused identically", async () => {
    const id = await newTicket();
    await expect(sdk().from(TICKETS).update(id, { status: "closed" } as never)).rejects.toThrow(
      /Cannot move/,
    );
  });

  test("MCP offers the same moves", async () => {
    const id = await newTicket();
    const out = (await mcp("items.transitions", { collection: TICKETS, id })) as any;
    const payload = out.structuredContent ?? JSON.parse(out.content[0].text);
    expect(payload.data[0].current).toBe("new");
    expect(payload.data[0].moves.map((m: any) => m.to)).toEqual(["open"]);
  });

  test("GraphQL offers the same moves, and only where a lifecycle exists", async () => {
    const id = await newTicket();
    const res = await gql(`query ($id: ID!) { surfTicketsTransitions(id: $id) }`, { id });
    expect(res.errors ?? []).toEqual([]);
    expect(res.data!.surfTicketsTransitions[0].moves.map((m: any) => m.to)).toEqual(["open"]);
  });

  test("a move fires an addressable flow trigger — and only for the edge it names", async () => {
    // The whole point of putting the edge IN the event name: a flow can ask for
    // "anything that reaches `open`" with the trigger grammar that already
    // exists, no condition to write and no before-value to re-derive.
    const LOG = "surf_moves";
    await h.fetch(
      "/api/collections",
      json({ slug: LOG, fields: [{ name: "note", type: "text" }] }),
    );
    await h.fetch(
      "/api/flows",
      json({
        name: "on-open",
        trigger: `event:items:${TICKETS}:transition:status:*:open`,
        active: true,
        operations: [{ type: "item.create", collection: LOG, data: { note: "opened" } }],
      }),
    );
    await h.fetch(
      "/api/flows",
      json({
        name: "on-closed",
        trigger: `event:items:${TICKETS}:transition:status:*:closed`,
        active: true,
        operations: [{ type: "item.create", collection: LOG, data: { note: "closed" } }],
      }),
    );

    const id = await newTicket();
    await h.fetch(`/api/items/${TICKETS}/${id}`, json({ status: "open" }, "PATCH"));
    // Dispatch is fire-and-forget; give the microtasks a turn.
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 25));

    const rows = (await (await h.fetch(`/api/items/${LOG}`)).json()).data as any[];
    expect(rows.map((r) => r.note)).toEqual(["opened"]);

    // An ordinary edit that does not move the status fires nothing.
    await h.fetch(`/api/items/${TICKETS}/${id}`, json({ title: "retitled" }, "PATCH"));
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 25));
    expect(((await (await h.fetch(`/api/items/${LOG}`)).json()).data as any[]).length).toBe(1);
  });

  test("the CLI still carries the transitions subcommand", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../../packages/cli/src/items.ts"), "utf8");
    expect(src).toContain("transitions <slug> <id>");
    expect(src).toContain(".transitions(id)");
  });

  test("the OpenAPI spec documents the transitions endpoint", async () => {
    const spec = (await (await h.fetch("/api/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(spec.paths).some((p) => p.endsWith("/{id}/transitions"))).toBe(true);
  });
});

describe("status transitions — the graph is integrity, the roles are permission", () => {
  const ORDERS = "role_orders";
  let admin: { email: string; password: string };

  beforeAll(async () => {
    h = makeHarness();
    admin = await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug: ORDERS,
        fields: [
          { name: "ref", type: "text" },
          {
            name: "status",
            type: "text",
            interface: "dropdown",
            options: {
              choices: [{ value: "pending" }, { value: "approved" }, { value: "rejected" }],
            },
            transitions: {
              allow: [
                { from: "pending", to: "approved", roles: ["admin"], label: "Approve" },
                { from: "pending", to: "rejected", label: "Reject" },
              ],
            },
          },
        ],
      }),
    );
  });
  afterAll(() => h.cleanup());

  /** Create a manual flow with a single `item.update` op and run it. */
  const runFlowUpdate = async (id: string, data: Record<string, unknown>) => {
    const flow = (
      await (
        await h.fetch(
          "/api/flows",
          json({
            name: `move-${crypto.randomUUID().slice(0, 8)}`,
            trigger: "manual:move",
            active: true,
            operations: [{ type: "item.update", collection: ORDERS, id, data }],
          }),
        )
      ).json()
    ).data;
    return h.fetch(`/api/flows/${flow.id}/run`, json({}));
  };

  const status = async (id: string) =>
    (await (await h.fetch(`/api/items/${ORDERS}/${id}`)).json()).data.status;

  test("a caller without the gated role is refused with 403, and told which role would do", async () => {
    const id = (await (await h.fetch(`/api/items/${ORDERS}`, json({ ref: "b", status: "pending" })))
      .json()).data.id as string;

    // Give the bundled `authenticated` role read + update on the collection, so
    // the only thing standing between it and the move is the transition's own
    // role gate — not a missing permission.
    const roles = ((await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    }).data;
    const authRoleId = roles.find((r) => r.name === "authenticated")!.id;
    for (const action of ["read", "update"]) {
      const r = await h.fetch(
        `/api/roles/${authRoleId}/permissions`,
        json({ collection: ORDERS, action, condition: null }),
      );
      expect(r.status).toBeLessThan(300);
    }

    await h.fetch("/api/auth/sign-out", { method: "POST" });
    const email = `member-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await h.fetch(
      "/api/auth/sign-up/email",
      json({ email, password: "correct-horse-battery", name: "Member" }),
    );

    const gated = await h.fetch(`/api/items/${ORDERS}/${id}`, json({ status: "approved" }, "PATCH"));
    expect(gated.status).toBe(403);
    const body = (await gated.json()) as any;
    expect(body.error.message).toContain("limited to");
    expect(body.error.details.refusal).toBe("forbidden_role");

    // The ungated edge out of the same state still works for them — the gate is
    // per-move, not per-field.
    const open = await h.fetch(`/api/items/${ORDERS}/${id}`, json({ status: "rejected" }, "PATCH"));
    expect(open.status).toBe(200);

    // …and the offer they are shown agrees with what the write path did.
    const offer = (await (await h.fetch(`/api/items/${ORDERS}/${id}/transitions`)).json())
      .data as any[];
    expect(offer[0].current).toBe("rejected");

    // Back to the admin identity — the next test authors a flow.
    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch("/api/auth/sign-in/email", json({ email: admin.email, password: admin.password }));
  });

  test("a flow-authored write is held to the graph but not to the role gate", async () => {
    const id = (await (await h.fetch(`/api/items/${ORDERS}`, json({ ref: "a", status: "pending" })))
      .json()).data.id as string;

    // The role gate does not apply — there is no user behind a flow, so
    // `roles: ["admin"]` on the edge is not a question this write can answer.
    const ok = await runFlowUpdate(id, { status: "approved" });
    expect(ok.status).toBe(200);
    expect(await status(id)).toBe("approved");

    // The graph does. `approved` leads nowhere, and a flow cannot walk back out
    // of it any more than a person can.
    const back = await runFlowUpdate(id, { status: "pending" });
    const body = (await back.json()) as any;
    const text = JSON.stringify(body);
    expect(text).toContain("Cannot move");
    expect(await status(id)).toBe("approved");
  });
});
