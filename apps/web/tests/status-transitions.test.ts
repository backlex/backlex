/**
 * Status transitions — the lifecycle a dropdown field is allowed to move through.
 *
 * What these cover is the thing that had no home before: the value a field is
 * changing FROM. Every other rule in the product judges the row a write would
 * produce, so `paid → draft` was two legal values in sequence and nothing could
 * say otherwise.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const INVOICES = "tr_invoices";

const STATUS_CHOICES = [
  { value: "draft" },
  { value: "open" },
  { value: "paid" },
  { value: "void" },
];

const invoiceFields = (overrides?: Record<string, unknown>) => [
  { name: "ref", type: "text" },
  { name: "void_reason", type: "text" },
  {
    name: "status",
    type: "text",
    interface: "dropdown",
    options: { choices: STATUS_CHOICES },
    transitions: {
      initial: ["draft"],
      allow: [
        { from: "draft", to: "open", label: "Send" },
        { from: "open", to: "paid", label: "Mark paid" },
        { from: ["draft", "open"], to: "void", requires: ["void_reason"], label: "Void" },
      ],
      ...overrides,
    },
  },
];

const create = async (data: Record<string, unknown>) =>
  h.fetch(`/api/items/${INVOICES}`, json(data));

const patch = async (id: string, data: Record<string, unknown>) =>
  h.fetch(`/api/items/${INVOICES}/${id}`, json(data, "PATCH"));

const read = async (id: string) =>
  (await (await h.fetch(`/api/items/${INVOICES}/${id}`)).json()).data as Record<string, unknown>;

const newInvoice = async (status = "draft"): Promise<string> =>
  (await (await create({ ref: crypto.randomUUID().slice(0, 8), status })).json()).data.id as string;

describe("status transitions", () => {
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(
      "/api/collections",
      json({ slug: INVOICES, fields: invoiceFields() }),
    );
    expect(res.status).toBe(201);
  });
  afterAll(() => h.cleanup());

  test("a legal move is accepted", async () => {
    const id = await newInvoice();
    expect((await patch(id, { status: "open" })).status).toBe(200);
    expect((await read(id)).status).toBe("open");
  });

  test("an illegal move is refused, and the row does not move", async () => {
    const id = await newInvoice();
    await patch(id, { status: "open" });
    await patch(id, { status: "paid" });

    const back = await patch(id, { status: "draft" });
    expect(back.status).toBe(422);
    const body = (await back.json()) as { error?: { message?: string; details?: any } };
    // The refusal says where the row can go instead — "paid" is terminal here.
    expect(body.error?.message ?? "").toContain("final state");
    expect(body.error?.details?.refusal).toBe("not_allowed");
    expect((await read(id)).status).toBe("paid");
  });

  test("skipping a state is refused even though both values are valid choices", async () => {
    const id = await newInvoice();
    const jump = await patch(id, { status: "paid" });
    expect(jump.status).toBe(422);
    expect((await read(id)).status).toBe("draft");
  });

  test("`initial` governs what a create may start as", async () => {
    const bad = await create({ ref: "x", status: "paid" });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.message).toContain("starting value");
    const ok = await create({ ref: "x", status: "draft" });
    expect(ok.status).toBe(201);
  });

  test("a row with no status yet is an initial assignment, not a move", async () => {
    // The field is optional, so this row starts empty — exactly what happens to
    // every existing row when a lifecycle is added to a live collection.
    const id = (await (await create({ ref: "no-status" })).json()).data.id as string;
    expect((await read(id)).status ?? null).toBe(null);
    // `initial` still applies (it governs the first value), but the row is not
    // stranded: it can be given one.
    expect((await patch(id, { status: "paid" })).status).toBe(422);
    expect((await patch(id, { status: "draft" })).status).toBe(200);
  });

  test("restating the current value is not a transition", async () => {
    const id = await newInvoice();
    await patch(id, { status: "open" });
    // A client that PATCHes the whole row back, status included, must not be
    // refused for a field it never intended to change.
    const echo = await patch(id, { ref: "renamed", status: "open" });
    expect(echo.status).toBe(200);
  });

  test("`requires` blocks the move until the field is filled — and accepts it in the same write", async () => {
    const id = await newInvoice();
    const bare = await patch(id, { status: "void" });
    expect(bare.status).toBe(422);
    const body = (await bare.json()) as { error?: { message?: string; details?: any } };
    expect(body.error?.details?.refusal).toBe("missing_fields");
    expect(body.error?.details?.missing).toEqual(["void_reason"]);
    expect((await read(id)).status).toBe("draft");

    // Supplying the reason in the SAME patch is enough — `requires` is judged
    // against the row the write would produce, not the row as stored.
    const together = await patch(id, { status: "void", void_reason: "duplicate" });
    expect(together.status).toBe(200);
    expect((await read(id)).status).toBe("void");
  });

  test("a value already present satisfies `requires` on a later write", async () => {
    const id = await newInvoice();
    await patch(id, { void_reason: "filed early" });
    expect((await patch(id, { status: "void" })).status).toBe(200);
  });

  test("the transitions endpoint explains every move, refused ones included", async () => {
    const id = await newInvoice();
    const res = await h.fetch(`/api/items/${INVOICES}/${id}/transitions`);
    expect(res.status).toBe(200);
    const [entry] = (await res.json()).data as any[];
    expect(entry.field).toBe("status");
    expect(entry.current).toBe("draft");
    expect(entry.terminal).toBe(false);
    const byTo = Object.fromEntries(entry.moves.map((m: any) => [m.to, m]));
    expect(Object.keys(byTo).sort()).toEqual(["open", "void"]);
    expect(byTo.open).toMatchObject({ allowed: true, label: "Send" });
    // The refused move is REPORTED, with what is missing — a button that is
    // visibly disabled because a reason is empty tells an operator what to do.
    expect(byTo.void).toMatchObject({ allowed: false, refusal: "missing_fields" });
    expect(byTo.void.missing).toEqual(["void_reason"]);
  });

  test("a terminal state reports itself as terminal, with no moves", async () => {
    const id = await newInvoice();
    await patch(id, { status: "open" });
    await patch(id, { status: "paid" });
    const [entry] = (await (await h.fetch(`/api/items/${INVOICES}/${id}/transitions`)).json())
      .data as any[];
    expect(entry).toMatchObject({ current: "paid", terminal: true });
    expect(entry.moves).toEqual([]);
  });

  test("the transitions endpoint 404s a row the caller cannot read", async () => {
    const res = await h.fetch(`/api/items/${INVOICES}/does-not-exist/transitions`);
    expect(res.status).toBe(404);
  });

  test("bulk update refuses the rows whose move is illegal", async () => {
    const draft = await newInvoice();
    const open = await newInvoice();
    await patch(open, { status: "open" });
    const res = await h.fetch(
      `/api/items/${INVOICES}/bulk-update`,
      json({ keys: [draft, open], data: { status: "paid" } }),
    );
    // The legal one lands, the illegal one does not — a bulk edit must not be
    // all-or-nothing on a per-row rule.
    const { data: body } = (await res.json()) as any;
    expect(body.updated).toBe(1);
    expect(body.failed).toBe(1);
    expect((await read(open)).status).toBe("paid");
    expect((await read(draft)).status).toBe("draft");
  });
});

describe("status transitions — what the checker refuses to leak or accept", () => {
  const RADIO = "tr_radio";
  const SCOPED = "tr_scoped";
  let admin: { email: string; password: string };

  beforeAll(async () => {
    h = makeHarness();
    admin = await seedAdmin(h);
    // A choice-bearing field whose interface is NOT `dropdown`. `validateValue`
    // only enforces choice membership for `dropdown`, so this is the shape that
    // could otherwise let an arbitrary value through a `to: "*"` rule.
    await h.fetch(
      "/api/collections",
      json({
        slug: RADIO,
        fields: [
          {
            name: "state",
            type: "text",
            interface: "radio",
            options: { choices: [{ value: "a" }, { value: "b" }] },
            transitions: { allow: [{ from: "*", to: "*" }] },
          },
        ],
      }),
    );
    await h.fetch(
      "/api/collections",
      json({
        slug: SCOPED,
        fields: [
          { name: "title", type: "text" },
          {
            name: "status",
            type: "text",
            interface: "dropdown",
            options: { choices: [{ value: "draft" }, { value: "done" }] },
            transitions: { allow: [{ from: "draft", to: "done" }] },
          },
        ],
      }),
    );
  });
  afterAll(() => h.cleanup());

  test("a `to: \"*\"` rule still cannot accept a value outside the field's choices", async () => {
    const id = (await (await h.fetch(`/api/items/${RADIO}`, json({ state: "a" }))).json()).data
      .id as string;
    // Without the membership check this lands: the wildcard rule matches
    // anything, and the value would go on to name the transition event —
    // `paid:whatever` shares its first segment with `paid` and would fire a
    // flow armed for it.
    const forged = await h.fetch(
      `/api/items/${RADIO}/${id}`,
      json({ state: "b:transition:state:a:b" }, "PATCH"),
    );
    expect(forged.status).toBe(422);
    expect((await forged.json()).error.message).toContain("not one of this field's values");
    expect((await (await h.fetch(`/api/items/${RADIO}/${id}`)).json()).data.state).toBe("a");
    // The real value still moves.
    expect((await h.fetch(`/api/items/${RADIO}/${id}`, json({ state: "b" }, "PATCH"))).status).toBe(200);
  });

  test("a create cannot start on a value outside the field's choices either", async () => {
    const bad = await h.fetch(`/api/items/${RADIO}`, json({ state: "zzz" }));
    expect(bad.status).toBe(422);
  });

  test("the transitions endpoint honours the caller's read FIELD allow-list", async () => {
    const id = (await (await h.fetch(`/api/items/${SCOPED}`, json({ title: "x", status: "draft" })))
      .json()).data.id as string;

    // Grant `authenticated` read on the collection but only on `title` — a
    // grant that excludes the status column.
    const roles = ((await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    }).data;
    const authRoleId = roles.find((r) => r.name === "authenticated")!.id;
    const grant = await h.fetch(
      `/api/roles/${authRoleId}/permissions`,
      json({ collection: SCOPED, action: "read", condition: null, fields: ["id", "title"] }),
    );
    expect(grant.status).toBeLessThan(300);

    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch(
      "/api/auth/sign-up/email",
      json({
        email: `narrow-${crypto.randomUUID().slice(0, 8)}@example.test`,
        password: "correct-horse-battery",
        name: "Narrow",
      }),
    );

    // The row read already hides the column…
    const row = (await (await h.fetch(`/api/items/${SCOPED}/${id}`)).json()).data;
    expect(row.status).toBeUndefined();
    // …so the endpoint that explains its next moves must not report it either.
    const res = await h.fetch(`/api/items/${SCOPED}/${id}/transitions`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);

    await h.fetch("/api/auth/sign-out", { method: "POST" });
    await h.fetch("/api/auth/sign-in/email", json({ email: admin.email, password: admin.password }));
    // The admin, who may read it, still sees the lifecycle.
    const asAdmin = (await (await h.fetch(`/api/items/${SCOPED}/${id}/transitions`)).json()).data;
    expect(asAdmin).toHaveLength(1);
    expect(asAdmin[0].current).toBe("draft");
  });
});

describe("status transitions — schema validation", () => {
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  const save = (fields: unknown[]) =>
    h.fetch("/api/collections", json({ slug: `v_${crypto.randomUUID().slice(0, 8)}`, fields }));

  test("a `from` that is not one of the field's choices is refused at save time", async () => {
    const res = await save([
      {
        name: "status",
        type: "text",
        interface: "dropdown",
        options: { choices: [{ value: "draft" }, { value: "open" }] },
        transitions: { allow: [{ from: "drafr", to: "open" }] },
      },
    ]);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("not one of this field's choices");
  });

  test("transitions on a field with no choices are refused", async () => {
    const res = await save([
      { name: "status", type: "text", transitions: { allow: [{ from: "*", to: "*" }] } },
    ]);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("options.choices");
  });

  test("`requires` naming a field that does not exist is refused", async () => {
    const res = await save([
      {
        name: "status",
        type: "text",
        interface: "dropdown",
        options: { choices: [{ value: "a" }, { value: "b" }] },
        transitions: { allow: [{ from: "a", to: "b", requires: ["nope"] }] },
      },
    ]);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("not a field on this collection");
  });

  test("a role nobody has is refused — it would be a move nobody can make", async () => {
    const res = await save([
      {
        name: "status",
        type: "text",
        interface: "dropdown",
        options: { choices: [{ value: "a" }, { value: "b" }] },
        transitions: { allow: [{ from: "a", to: "b", roles: ["chief_invoicer"] }] },
      },
    ]);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("do not exist in this workspace");
  });

  test("a choice containing ':' is refused — the value names the flow trigger", async () => {
    const res = await save([
      {
        name: "status",
        type: "text",
        interface: "dropdown",
        options: { choices: [{ value: "a:b" }, { value: "c" }] },
        transitions: { allow: [{ from: "a:b", to: "c" }] },
      },
    ]);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain('cannot contain ":"');
  });

  test("transitions on a non-text field are refused", async () => {
    const res = await save([
      {
        name: "score",
        type: "integer",
        options: { choices: [{ value: "1" }] },
        transitions: { allow: [{ from: "1", to: "1" }] },
      },
    ]);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("text dropdown");
  });
});
