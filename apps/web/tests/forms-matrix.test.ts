import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Matrix blocks — several questions asked on one shared set of columns.
 *
 * The load-bearing claim is that a matrix is a way of DRAWING questions and not
 * a way of storing them: each row writes into its own ordinary column, so the
 * submit clamp, the bound checks and the results panel go on reading the rows
 * as the questions they are. These tests pin that claim from both ends — the
 * definition the page renders, and the summary the panel reads back — plus the
 * refusals that keep a grid from being drawn under columns its rows don't share.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

interface PublicBlock {
  kind: string;
  name?: string;
  label: string;
  scale: { min: number; max: number; style: string } | null;
  choices: { value: string; label?: string }[] | null;
  matrix: { id: string; label: string; help: string | null } | null;
}

describe("form matrix blocks", () => {
  let h: TestHarness;
  const slug = `matrix_${Date.now()}`;

  const publicFetch = (path: string, init?: RequestInit) =>
    h.app.fetch(new Request(`${h.env.APP_URL}${path}`, init));

  const createForm = (fields: unknown[], name = "Matrix form") =>
    h.fetch("/api/admin/forms", json({ name, collection: slug, fields }));

  const AGREEMENT = [{ value: "agree" }, { value: "neutral" }, { value: "disagree" }];

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "speed", type: "integer", label: "Speed" },
          { name: "friendliness", type: "integer" },
          { name: "value", type: "integer" },
          { name: "recommends", type: "text", options: { choices: AGREEMENT } },
          { name: "returns", type: "text", label: "I would come back", options: { choices: AGREEMENT } },
          // Same idea, different words — a grid drawn over these two would have
          // a third column meaning two different things.
          { name: "mood", type: "text", options: { choices: [{ value: "good" }, { value: "bad" }] } },
          { name: "comment", type: "longtext" },
        ],
      }),
    );
    expect(created.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  /* ── definition ──────────────────────────────────────────────────── */

  test("a scale matrix reaches the page as one field block per row", async () => {
    const res = await createForm([
      {
        id: "m1",
        kind: "matrix",
        label: "How was our support?",
        help: "Pick one per line",
        scale: { min: 1, max: 5, style: "number", minLabel: "Poor", maxLabel: "Great" },
        rows: [{ name: "speed" }, { name: "friendliness", label: "Friendliness" }],
      },
      { name: "comment" },
    ]);
    expect(res.status).toBe(201);
    const token = ((await res.json()) as { data: { token: string } }).data.token;

    const def = await publicFetch(`/api/public/forms/${token}`);
    const blocks = ((await def.json()) as { data: { blocks: PublicBlock[] } }).data.blocks;

    // Two rows, two ordinary field blocks — a bundle that predates matrices
    // renders them as the plain scale rows they also are.
    const rows = blocks.filter((b) => b.matrix);
    expect(rows.map((b) => b.name)).toEqual(["speed", "friendliness"]);
    expect(rows.every((b) => b.kind === "field")).toBe(true);
    // The shared scale is copied onto every row: the columns are the same for
    // all of them, which is the entire premise of a grid.
    expect(rows[0]!.scale).toEqual({
      min: 1,
      max: 5,
      style: "number",
      minLabel: "Poor",
      maxLabel: "Great",
    });
    expect(rows[1]!.scale).toEqual(rows[0]!.scale);
    // The grid's own question is asked once, on the marker, not per row.
    expect(rows[0]!.matrix).toEqual({
      id: "m1",
      label: "How was our support?",
      help: "Pick one per line",
    });
    expect(rows[1]!.label).toBe("Friendliness");
    // Row captions fall back to the field's own label.
    expect(rows[0]!.label).toBe("Speed");
    // Blocks outside the matrix are untouched.
    expect(blocks.find((b) => b.name === "comment")?.matrix ?? null).toBeNull();
  });

  test("a choice matrix draws its columns from the choices its rows share", async () => {
    const res = await createForm([
      {
        id: "likert",
        kind: "matrix",
        label: "How much do you agree?",
        rows: [{ name: "recommends" }, { name: "returns" }],
      },
    ]);
    expect(res.status).toBe(201);
    const token = ((await res.json()) as { data: { token: string } }).data.token;

    const def = await publicFetch(`/api/public/forms/${token}`);
    const blocks = ((await def.json()) as { data: { blocks: PublicBlock[] } }).data.blocks;
    const rows = blocks.filter((b) => b.matrix);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.scale).toBeNull();
    expect(rows[0]!.choices?.map((c) => c.value)).toEqual(["agree", "neutral", "disagree"]);
    expect(rows[1]!.choices).toEqual(rows[0]!.choices);
    expect(rows[0]!.matrix?.id).toBe("likert");
  });

  /* ── refusals ────────────────────────────────────────────────────── */

  const refused = async (fields: unknown[], expected: RegExp) => {
    const res = await createForm(fields);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error?: { message?: string }; message?: string };
    expect(JSON.stringify(body)).toMatch(expected);
  };

  test("rows that cannot agree on a set of columns are refused when the form is saved", async () => {
    // Choices that differ: the third column would mean two different things.
    await refused(
      [{ kind: "matrix", label: "Mixed", rows: [{ name: "recommends" }, { name: "mood" }] }],
      /same choices in the same order/,
    );
    // A row with no choices and no scale is answered on nothing at all.
    await refused(
      [{ kind: "matrix", label: "Empty columns", rows: [{ name: "recommends" }, { name: "comment" }] }],
      /offers no choices/,
    );
    // A scale needs an integer column to write its answer into.
    await refused(
      [
        {
          kind: "matrix",
          label: "Scaled text",
          scale: { min: 1, max: 5, style: "number" },
          rows: [{ name: "speed" }, { name: "recommends" }],
        },
      ],
      /needs an integer column/,
    );
    await refused(
      [{ kind: "matrix", label: "Nothing", rows: [] }],
      /at least one row/,
    );
    await refused(
      [{ kind: "matrix", label: "Ghost", rows: [{ name: "nope" }] }],
      /cannot be exposed/,
    );
  });

  test("a field cannot be asked twice — as two blocks or as a block and a row", async () => {
    await refused(
      [
        { name: "speed" },
        {
          kind: "matrix",
          label: "Support",
          scale: { min: 1, max: 5, style: "number" },
          rows: [{ name: "speed" }, { name: "friendliness" }],
        },
      ],
      /on the form twice/,
    );
  });

  /* ── answers ─────────────────────────────────────────────────────── */

  test("rows are clamped, bounded and summarised as the questions they are", async () => {
    const res = await createForm(
      [
        {
          id: "m2",
          kind: "matrix",
          label: "Rate us",
          scale: { min: 1, max: 5, style: "number" },
          rows: [{ name: "speed" }, { name: "friendliness" }],
        },
        { id: "m3", kind: "matrix", label: "Agree?", rows: [{ name: "recommends" }] },
      ],
      "Answerable matrix",
    );
    expect(res.status).toBe(201);
    const { form, token } = ((await res.json()) as {
      data: { form: { id: string }; token: string };
    }).data;

    const submit = (data: Record<string, unknown>) =>
      publicFetch(`/api/public/forms/${token}/submit`, json({ data }));

    expect((await submit({ speed: 5, friendliness: 4, recommends: "agree" })).status).toBe(201);
    expect((await submit({ speed: 3, friendliness: 4, recommends: "disagree" })).status).toBe(201);

    // The page can only send a point it drew — the endpoint is public, and a
    // hand-written POST is not the page.
    const offScale = await submit({ speed: 47 });
    expect(offScale.status).toBe(422);
    // …and the same holds for a column that is in no header.
    const offColumn = await submit({ recommends: "maybe" });
    expect(offColumn.status).toBe(422);
    // A field the matrix never named is dropped rather than written.
    const padded = await submit({ speed: 2, value: 5 });
    expect(padded.status).toBe(201);

    const summary = await h.fetch(`/api/admin/forms/${form.id}/results`);
    expect(summary.status).toBe(200);
    const blocks = ((await summary.json()) as {
      data: {
        blocks: Array<{
          name: string;
          kind: string;
          answered: number;
          average: number | null;
          matrix: { id: string; label: string } | null;
        }>;
      };
    }).data.blocks;

    const speed = blocks.find((b) => b.name === "speed")!;
    expect(speed.kind).toBe("scale");
    expect(speed.answered).toBe(3);
    // (5 + 3 + 2) / 3 — the mean of a column, not of a grid.
    expect(speed.average).toBe(3.33);
    expect(speed.matrix).toEqual({ id: "m2", label: "Rate us" });
    // Rows of different matrices are grouped under their own heading.
    expect(blocks.find((b) => b.name === "recommends")!.matrix).toEqual({
      id: "m3",
      label: "Agree?",
    });
    expect(blocks.find((b) => b.name === "recommends")!.kind).toBe("choice");
    // Nothing wrote the padded field.
    expect(blocks.some((b) => b.name === "value")).toBe(false);
  });

  test("a matrix whose rows lose their shared columns drops out whole", async () => {
    const res = await createForm(
      [{ id: "m4", kind: "matrix", label: "Agree?", rows: [{ name: "recommends" }, { name: "returns" }] }],
      "Fragile matrix",
    );
    expect(res.status).toBe(201);
    const token = ((await res.json()) as { data: { token: string } }).data.token;

    // The choices move under the form's feet. Half a grid — one row answered on
    // columns the other row doesn't offer — is not a question anyone can
    // answer, so the whole block goes rather than the odd row.
    const patched = await h.fetch(`/api/collections/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: [
          { name: "recommends", type: "text", options: { choices: AGREEMENT } },
          {
            name: "returns",
            type: "text",
            label: "I would come back",
            options: { choices: [{ value: "yes" }, { value: "no" }] },
          },
        ],
      }),
    });
    expect(patched.status).toBe(200);

    const def = await publicFetch(`/api/public/forms/${token}`);
    const blocks = ((await def.json()) as { data: { blocks: PublicBlock[] } }).data.blocks;
    expect(blocks.filter((b) => b.matrix)).toHaveLength(0);
  });
});
