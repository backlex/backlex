import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Multi-surface parity for the public form builder. Pins REST + GraphQL + SDK
 * to the same `/api/admin/forms` semantics, plus the public define/submit
 * round-trip (`/api/public/forms/:token`) which has no session. MCP wraps the
 * same REST endpoints (dispatch covered in mcp.test.ts).
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const seedCollection = async (h: TestHarness, slug: string) => {
  const res = await h.fetch(
    "/api/collections",
    json({
      slug,
      fields: [
        { name: "title", type: "text", required: true },
        { name: "note", type: "longtext" },
        { name: "secret", type: "text", private: true },
      ],
    }),
  );
  expect(res.status).toBe(201);
};

describe("forms — GraphQL surface", () => {
  let h: TestHarness;
  const slug = `gql_forms_${Date.now()}`;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await seedCollection(h, slug);
  });
  afterAll(() => h.cleanup());

  test("createPublicForm → publicForm(s) → update → rotate → delete round-trips", async () => {
    const created = await gql(
      `mutation($d:PublicFormInput!){ createPublicForm(data:$d){ form { id name collection active } token url embedUrl } }`,
      { d: { name: "gql-form", collection: slug, fields: [{ name: "title" }] } },
    );
    expect(created.errors).toBeUndefined();
    const payload = created.data?.createPublicForm;
    const id = payload.form.id as string;
    expect(payload.token.startsWith("frm_")).toBe(true);
    expect(payload.url).toBe(`/f/${payload.token}`);
    expect(payload.embedUrl).toBe(`/embed/f/${payload.token}`);
    expect(payload.form.active).toBe(true);

    const one = await gql(`query($id:ID!){ publicForm(id:$id){ id name fields } }`, { id });
    expect(one.data?.publicForm.name).toBe("gql-form");

    const list = await gql(`{ publicForms { id name } }`);
    expect(list.data?.publicForms.some((f: any) => f.id === id)).toBe(true);

    const updated = await gql(
      `mutation($id:ID!,$d:PublicFormInput!){ updatePublicForm(id:$id, data:$d){ id name active } }`,
      { id, d: { name: "gql-form-2", active: false } },
    );
    expect(updated.errors).toBeUndefined();
    expect(updated.data?.updatePublicForm.name).toBe("gql-form-2");
    expect(updated.data?.updatePublicForm.active).toBe(false);

    const rotated = await gql(
      `mutation($id:ID!){ rotatePublicFormToken(id:$id){ token url embedUrl } }`,
      { id },
    );
    expect(rotated.errors).toBeUndefined();
    expect(rotated.data?.rotatePublicFormToken.token).not.toBe(payload.token);

    const deleted = await gql(`mutation($id:ID!){ deletePublicForm(id:$id) }`, { id });
    expect(deleted.data?.deletePublicForm).toBe(true);
    const gone = await gql(`query($id:ID!){ publicForm(id:$id){ id } }`, { id });
    expect(gone.data?.publicForm).toBeNull();
  });

  test("eligibility fence holds on GraphQL too (private field rejected)", async () => {
    const bad = await gql(
      `mutation($d:PublicFormInput!){ createPublicForm(data:$d){ form { id } } }`,
      { d: { name: "bad", collection: slug, fields: [{ name: "secret" }] } },
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });
});

describe("forms — SDK surface + public round-trip", () => {
  let h: TestHarness;
  const slug = `sdk_forms_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await seedCollection(h, slug);
  });
  afterAll(() => h.cleanup());

  test("client.forms.* CRUD + anonymous submit through the SDK-created form", async () => {
    const client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

    const eligible = await client.forms.eligibleFields(slug);
    expect(eligible.data.map((f) => f.name)).toEqual(["title", "note"]);

    const created = await client.forms.create({
      name: "sdk-form",
      collection: slug,
      fields: [{ name: "title", label: "Title" }, { name: "note" }],
      settings: { successMessage: "ok!" },
    });
    expect(created.data.token.startsWith("frm_")).toBe(true);
    const id = created.data.form.id;

    const list = await client.forms.list();
    expect(list.data.some((f) => f.id === id)).toBe(true);
    expect(Object.keys(list.data.find((f) => f.id === id)!)).not.toContain("tokenHash");

    const updated = await client.forms.update(id, { name: "sdk-form-2" });
    expect(updated.data.name).toBe("sdk-form-2");

    // Public round-trip with NO session: definition renders the exposed set,
    // submit lands the row (verified via the admin surface afterwards).
    const def = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/public/forms/${created.data.token}`),
    );
    expect(def.status).toBe(200);
    const defBody = (await def.json()) as {
      data: { blocks: { name?: string; label: string }[]; successMessage: string | null };
    };
    expect(defBody.data.blocks.map((f) => f.name)).toEqual(["title", "note"]);
    expect(defBody.data.blocks[0]!.label).toBe("Title");
    expect(defBody.data.successMessage).toBe("ok!");

    const submit = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/public/forms/${created.data.token}/submit`, {
        ...json({ data: { title: "from public", note: "hi" } }),
      }),
    );
    expect(submit.status).toBe(201);

    const rows = await h.fetch(`/api/items/${slug}`);
    const items = ((await rows.json()) as { data: Record<string, unknown>[] }).data;
    expect(items.length).toBe(1);
    expect(items[0]!.title).toBe("from public");

    const rotated = await client.forms.rotateToken(id);
    expect(rotated.data.token).not.toBe(created.data.token);
    const oldGone = await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/public/forms/${created.data.token}`),
    );
    expect(oldGone.status).toBe(404);

    const removed = await client.forms.delete(id);
    expect(removed.ok).toBe(true);
  });

  test("non-admin sessions are rejected by the admin surface", async () => {
    // No session at all → 401 from requireUser.
    const anon = await h.app.fetch(new Request(`${h.env.APP_URL}/api/admin/forms`));
    expect(anon.status).toBe(401);
  });
});
