/**
 * Multi-surface parity for order fields.
 *
 * Two guarantees, and each has a different way of quietly not shipping:
 *
 *   1. **Every surface that CREATES a row appends it to the end of its list.**
 *      This is the one the parity gate exists for. The REST write core does it
 *      in `performCreate`, but the GraphQL create resolver hand-builds its own
 *      INSERT and does not go through that function — the same gap that made
 *      #38's rollups, #39's sequence numbers and #40's points ship on REST only
 *      until a test like this one caught it. A GraphQL-created row landing on
 *      the column default (0, tied with everything else) while the identical
 *      REST create appended correctly is invisible until someone drags.
 *   2. **Every surface can MOVE a row**, and they all reach the same planner —
 *      so the shift arithmetic and the tie repair cannot drift apart.
 *
 * The CLI is checked structurally rather than by spawning a shell — it is a thin
 * argv parser over the SDK, and what rots is a subcommand quietly disappearing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../../../packages/client/src/index";
import { orderTools } from "../src/server/mcp/tools/order";
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
  const tool = orderTools.find((x) => x.name === name)!;
  return tool.handler(args, {
    fetchInternal: (p: string, init?: RequestInit) => h.fetch(p, init),
  } as never);
};

const boards = "parord_boards";
const cards = "parord_cards";

/** The list, read back in position order. */
const positions = async (board: string): Promise<{ name: string; position: number }[]> => {
  const r = await h.fetch(
    `/api/items/${cards}?sort=position&limit=100&filter=${encodeURIComponent(
      JSON.stringify({ board: { _eq: board } }),
    )}`,
  );
  return ((await r.json()).data as Record<string, any>[]).map((x) => ({
    name: x.name,
    position: x.position,
  }));
};

const newBoard = async (): Promise<string> =>
  (await (await h.fetch(`/api/items/${boards}`, json({ name: crypto.randomUUID().slice(0, 8) }))).json())
    .data.id as string;

describe("order fields — multi-surface parity", () => {
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({ slug: boards, fields: [{ name: "name", type: "text" }] }),
    );
    await h.fetch(
      "/api/collections",
      json({
        slug: cards,
        fields: [
          { name: "name", type: "text" },
          { name: "board", type: "relation", to: boards },
          { name: "position", type: "integer", order: { scope: "board" } },
        ],
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("REST: creates append, and reorder moves", async () => {
    const b = await newBoard();
    for (const name of ["a", "b", "c"]) {
      await h.fetch(`/api/items/${cards}`, json({ name, board: b }));
    }
    expect(await positions(b)).toEqual([
      { name: "a", position: 1 },
      { name: "b", position: 2 },
      { name: "c", position: 3 },
    ]);
    const ids = ((await (await h.fetch(`/api/items/${cards}?sort=position&filter=${encodeURIComponent(JSON.stringify({ board: { _eq: b } }))}`)).json()).data as any[]).map(
      (x) => x.id as string,
    );
    const moved = await h.fetch(
      `/api/items/${cards}/reorder`,
      json({ field: "position", id: ids[2], before: ids[0] }),
    );
    expect(moved.status).toBe(200);
    expect((await positions(b)).map((x) => x.name)).toEqual(["c", "a", "b"]);
  });

  test("GraphQL: a create appends instead of landing on the column default", async () => {
    // The gate. This resolver hand-builds its INSERT, so without the append
    // wired in here every GraphQL-created row would share position 0 while the
    // identical REST create numbered correctly.
    const b = await newBoard();
    for (const name of ["g1", "g2", "g3"]) {
      const r = await gql(
        `mutation ($data: ParordCardsInput!) { createParordCards(data: $data) { id position } }`,
        { data: { name, board: b } },
      );
      expect(r.errors ?? []).toEqual([]);
    }
    // Asserted through REST so the check is about the COLUMN, not about what
    // the mutation chose to echo back.
    expect(await positions(b)).toEqual([
      { name: "g1", position: 1 },
      { name: "g2", position: 2 },
      { name: "g3", position: 3 },
    ]);
  });

  test("GraphQL: the create response carries the position it was given", async () => {
    // Separately from the column check above — a resolver that appended
    // correctly but echoed `position: null` would leave every GraphQL client
    // showing a blank where the row's place is.
    const b = await newBoard();
    const r = await gql(
      `mutation ($data: ParordCardsInput!) { createParordCards(data: $data) { position } }`,
      { data: { name: "echo", board: b } },
    );
    expect(r.data?.createParordCards?.position).toBe(1);
  });

  test("GraphQL: reorderItem + normalizeOrder move the same rows REST does", async () => {
    const b = await newBoard();
    const ids: string[] = [];
    for (const name of ["x", "y", "z"]) {
      const r = await gql(
        `mutation ($data: ParordCardsInput!) { createParordCards(data: $data) { id } }`,
        { data: { name, board: b } },
      );
      ids.push(r.data!.createParordCards.id as string);
    }
    const moved = await gql(
      `mutation ($c: String!, $f: String!, $id: ID!, $a: ID!) {
         reorderItem(collection: $c, field: $f, id: $id, after: $a) { position shifted }
       }`,
      { c: cards, f: "position", id: ids[0], a: ids[2] },
    );
    expect(moved.errors ?? []).toEqual([]);
    expect((await positions(b)).map((x) => x.name)).toEqual(["y", "z", "x"]);

    const norm = await gql(
      `mutation ($c: String!) { normalizeOrder(collection: $c) { scopes renumbered fields } }`,
      { c: cards },
    );
    expect(norm.errors ?? []).toEqual([]);
    expect(norm.data?.normalizeOrder?.fields).toEqual(["position"]);
  });

  test("GraphQL: a re-parent appends to the list the row joined", async () => {
    const from = await newBoard();
    const to = await newBoard();
    await h.fetch(`/api/items/${cards}`, json({ name: "sitting", board: to }));
    const r = await gql(
      `mutation ($data: ParordCardsInput!) { createParordCards(data: $data) { id } }`,
      { data: { name: "wanderer", board: from } },
    );
    const id = r.data!.createParordCards.id as string;
    const upd = await gql(
      `mutation ($id: ID!, $data: ParordCardsInput!) { updateParordCards(id: $id, data: $data) { position } }`,
      { id, data: { board: to } },
    );
    expect(upd.errors ?? []).toEqual([]);
    // Not 1 — that position is taken in the list it joined, and a tie is the one
    // state a later move cannot survive.
    expect(upd.data?.updateParordCards?.position).toBe(2);
  });

  test("SDK: create appends, reorder moves, normalizeOrder reports", async () => {
    const c = sdk();
    const b = await newBoard();
    const ids: string[] = [];
    for (const name of ["s1", "s2", "s3"]) {
      const row = await c.from(cards).create({ name, board: b } as never);
      ids.push((row.data as any).id as string);
    }
    expect(await positions(b)).toEqual([
      { name: "s1", position: 1 },
      { name: "s2", position: 2 },
      { name: "s3", position: 3 },
    ]);
    const res = await c.from(cards).reorder("position", ids[0]!, { after: ids[2]! });
    expect(res.position).toBe(3);
    expect((await positions(b)).map((x) => x.name)).toEqual(["s2", "s3", "s1"]);

    const norm = await c.from(cards).normalizeOrder("position");
    expect(norm.fields).toEqual(["position"]);
    // A second run changes nothing — the pass is idempotent, which is what makes
    // it safe for a move to call speculatively.
    expect((await c.from(cards).normalizeOrder("position")).renumbered).toBe(0);
  });

  test("batch creates number sequentially rather than colliding", async () => {
    // The whole reason the append is a SUBQUERY: a batch is many INSERTs, and a
    // maximum this process read once would give every row of it the same number.
    const b = await newBoard();
    const r = await h.fetch(
      `/api/items/${cards}/batch`,
      json({
        operations: [
          { op: "create", data: { name: "n1", board: b } },
          { op: "create", data: { name: "n2", board: b } },
          { op: "create", data: { name: "n3", board: b } },
        ],
      }),
    );
    expect(r.status).toBe(200);
    expect(await positions(b)).toEqual([
      { name: "n1", position: 1 },
      { name: "n2", position: 2 },
      { name: "n3", position: 3 },
    ]);
  });

  test("an ATOMIC batch numbers sequentially too", async () => {
    // Atomic mode COLLECTS statements and replays them in one transaction, so
    // the subquery is evaluated at replay time. If the append had been a number
    // read up front, all three rows would tie here and nowhere else.
    const b = await newBoard();
    const r = await h.fetch(
      `/api/items/${cards}/batch`,
      json({
        atomic: true,
        operations: [
          { op: "create", data: { name: "t1", board: b } },
          { op: "create", data: { name: "t2", board: b } },
          { op: "create", data: { name: "t3", board: b } },
        ],
      }),
    );
    expect(r.status).toBe(200);
    expect((await positions(b)).map((x) => x.position)).toEqual([1, 2, 3]);
  });

  test("MCP: order.move and order.normalize reach the same routes", async () => {
    const b = await newBoard();
    const ids: string[] = [];
    for (const name of ["m1", "m2", "m3"]) {
      const row = await (await h.fetch(`/api/items/${cards}`, json({ name, board: b }))).json();
      ids.push(row.data.id as string);
    }
    const moved = (await mcp("order.move", {
      collection: cards,
      field: "position",
      id: ids[2],
      before: ids[0],
    })) as { structuredContent: any };
    expect(moved.structuredContent.data.position).toBe(1);
    expect((await positions(b)).map((x) => x.name)).toEqual(["m3", "m1", "m2"]);

    const norm = (await mcp("order.normalize", { collection: cards })) as {
      structuredContent: any;
    };
    expect(norm.structuredContent.data.fields).toEqual(["position"]);
  });

  test("MCP exposes exactly the two ordering tools, and no raw position setter", async () => {
    // A `order.set` tool would invite an agent to do what a person with a form
    // does today — renumber the neighbours by hand, getting one wrong.
    expect(orderTools.map((t) => t.name).sort()).toEqual(["order.move", "order.normalize"]);
  });

  test("the CLI still carries both subcommands", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../../packages/cli/src/items.ts"), "utf8");
    expect(src).toContain('case "reorder"');
    expect(src).toContain('case "normalize-order"');
    expect(src).toContain(".reorder(");
    expect(src).toContain(".normalizeOrder(");
  });

  test("the OpenAPI spec documents both endpoints", async () => {
    const spec = (await (await h.fetch("/api/openapi.json")).json()) as {
      paths: Record<string, unknown>;
    };
    const keys = Object.keys(spec.paths);
    expect(keys.some((p) => p.endsWith("/reorder"))).toBe(true);
    expect(keys.some((p) => p.endsWith("/order/normalize"))).toBe(true);
  });
});
