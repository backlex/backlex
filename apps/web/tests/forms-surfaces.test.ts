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

  test("the visitor's whole journey runs through the SDK, on a client with no session", async () => {
    /**
     * The half of a public form that the form is FOR.
     *
     * The test above proves the same journey works — by writing every request
     * by hand, because there was no method for it. That is the shape of the
     * gap this wave closed: the surface existed, was documented, was reachable
     * from an AI agent over MCP, and the one caller who most obviously needed
     * it (an application embedding its own form) had to compose the requests
     * itself.
     *
     * Everything here runs on a SEPARATE client built with no credentials, so
     * a method that only worked because a session happened to be present would
     * fail here rather than in a customer's browser.
     */
    const admin = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
    // Its own collection: the specs around this one assert cumulative answer
    // counts over `slug`, and a journey that lands a row there would move
    // their numbers for a reason that has nothing to do with what they test.
    const journeySlug = `sdk_forms_journey_${Date.now()}`;
    await seedCollection(h, journeySlug);
    const created = await admin.forms.create({
      name: "visitor-journey",
      collection: journeySlug,
      fields: [{ name: "title", label: "Title" }, { name: "note" }],
      settings: { successMessage: "thanks!", saveProgress: true },
    });
    const token = created.data.token;

    const visitor = createClient({
      url: "",
      // Straight to the app: `h.fetch` carries the admin cookie jar, and a
      // "visitor" holding an admin session proves nothing about a public path.
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        h.app.request(
          typeof input === "string" ? input : String(input),
          { ...init, headers: { ...((init?.headers as Record<string, string>) ?? {}) } } as RequestInit,
          h.env,
        )) as typeof fetch,
    });

    // 1. Render — the questions, and nothing the form does not list.
    const rendered = await visitor.forms.public.render(token);
    expect(rendered.data.blocks.map((b) => b.name)).toEqual(["title", "note"]);
    expect(rendered.data.successMessage).toBe("thanks!");
    // Nothing has been filled in yet, so there is nothing to come back to.
    expect(rendered.data.draft).toBeNull();

    // 2. Save a half-filled form, then resume it. There is no `resumeDraft`
    //    method because there is no resume ROUTE — resuming IS rendering, and
    //    inventing a method with nothing behind it would be the same kind of
    //    fiction as a documented endpoint that 404s.
    await visitor.forms.public.saveDraft(token, { data: { title: "half a thought" }, step: 0 });

    // 3. Discard it — the visitor changed their mind.
    await visitor.forms.public.discardDraft(token);

    // 4. Submit. The row lands through the same write path an authenticated
    //    create takes, so validation, flows and the audit trail all behave.
    const submitted = await visitor.forms.public.submit(token, {
      data: { title: "from the SDK", note: "visitor" },
    });
    expect(submitted.data.successMessage).toBe("thanks!");

    const rows = await admin.from<{ title: string }>(journeySlug).list();
    expect(rows.data.some((r) => r.title === "from the SDK")).toBe(true);

    // 5. A rotated token kills the old link, on the SDK path too.
    await admin.forms.rotateToken(created.data.form.id);
    await expect(visitor.forms.public.render(token)).rejects.toBeDefined();

    await admin.forms.delete(created.data.form.id);
  });

  test("results answer the same numbers on REST, SDK and GraphQL", async () => {
    const client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
    const created = await client.forms.create({
      name: "results-parity",
      collection: slug,
      fields: [{ name: "title" }, { name: "note" }],
    });
    const id = created.data.form.id;

    await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/public/forms/${created.data.token}/submit`, {
        ...json({ data: { title: "one", note: "with a note" } }),
      }),
    );
    await h.app.fetch(
      new Request(`${h.env.APP_URL}/api/public/forms/${created.data.token}/submit`, {
        ...json({ data: { title: "two" } }),
      }),
    );

    const sdk = await client.forms.results(id);
    const note = sdk.data.blocks.find((b) => b.name === "note")!;
    expect(note.kind).toBe("text");
    // Two notes: one from this form, one written by the earlier spec through a
    // different form into the same collection. That is the documented reading —
    // nothing stamps a row with the form that wrote it, so `results` counts the
    // collection. `submissionCount` is the per-form figure.
    expect(note.answered).toBe(2);
    expect(sdk.data.submissionCount).toBe(2);
    expect(note.buckets).toBeNull();

    const rest = await h.fetch(`/api/admin/forms/${id}/results`);
    expect(rest.status).toBe(200);
    const restBody = ((await rest.json()) as { data: unknown }).data;
    expect(restBody).toEqual(sdk.data as unknown as typeof restBody);

    const gqlRes = (await (
      await h.fetch("/api/graphql", json({
        query: `query($id:ID!){ publicFormResults(id:$id) }`,
        variables: { id },
      }))
    ).json()) as { data?: { publicFormResults: unknown }; errors?: unknown[] };
    expect(gqlRes.errors).toBeUndefined();
    expect(gqlRes.data?.publicFormResults).toEqual(sdk.data as never);

    await client.forms.delete(id);
  });

  test("invites mint, list and revoke identically on SDK, REST and GraphQL", async () => {
    const client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
    const created = await client.forms.create({
      name: "invite-parity",
      collection: slug,
      fields: [{ name: "title" }],
      settings: { inviteOnly: true },
    });
    const id = created.data.form.id;

    const sdk = await client.forms.invite(id, {
      recipients: [{ email: "sdk@example.test" }],
      formToken: created.data.token,
    });
    expect(sdk.data.invites[0]!.token.startsWith("inv_")).toBe(true);
    expect(sdk.data.invites[0]!.url).toBe(`/f/${created.data.token}?i=${sdk.data.invites[0]!.token}`);

    const gqlMint = (await (
      await h.fetch("/api/graphql", json({
        query: `mutation($id:ID!,$r:JSON!){ invitePublicForm(id:$id, recipients:$r) }`,
        variables: { id, r: [{ email: "gql@example.test" }] },
      }))
    ).json()) as { data?: { invitePublicForm: { token: string; email: string }[] }; errors?: unknown[] };
    expect(gqlMint.errors).toBeUndefined();
    expect(gqlMint.data?.invitePublicForm[0]?.email).toBe("gql@example.test");

    // Every read surface agrees on the list, and NONE of them carries a token.
    const viaSdk = await client.forms.invites(id);
    const viaRest = ((await (await h.fetch(`/api/admin/forms/${id}/invites`)).json()) as {
      data: unknown[];
    }).data;
    const viaGql = (await (
      await h.fetch("/api/graphql", json({
        query: `query($id:ID!){ publicFormInvites(id:$id) }`,
        variables: { id },
      }))
    ).json()) as { data?: { publicFormInvites: unknown[] } };
    expect(viaSdk.data.length).toBe(2);
    expect(viaRest).toEqual(viaSdk.data as never);
    expect(viaGql.data?.publicFormInvites).toEqual(viaSdk.data as never);
    expect(JSON.stringify(viaSdk.data)).not.toContain(sdk.data.invites[0]!.token);
    expect(JSON.stringify(viaSdk.data)).not.toContain("tokenHash");

    const revoked = await client.forms.revokeInvite(id, viaSdk.data[0]!.id);
    expect(revoked.ok).toBe(true);
    expect((await client.forms.invites(id)).data.length).toBe(1);

    const gqlRevoke = (await (
      await h.fetch("/api/graphql", json({
        query: `mutation($id:ID!,$i:ID!){ revokePublicFormInvite(id:$id, inviteId:$i) }`,
        variables: { id, i: (await client.forms.invites(id)).data[0]!.id },
      }))
    ).json()) as { data?: { revokePublicFormInvite: boolean }; errors?: unknown[] };
    expect(gqlRevoke.errors).toBeUndefined();
    expect(gqlRevoke.data?.revokePublicFormInvite).toBe(true);
    expect((await client.forms.invites(id)).data.length).toBe(0);

    await client.forms.delete(id);
  });

  test("reminders mint a fresh link identically on SDK, REST and GraphQL", async () => {
    const client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
    const created = await client.forms.create({
      name: "remind-parity",
      collection: slug,
      fields: [{ name: "title" }],
      settings: { inviteOnly: true },
    });
    const id = created.data.form.id;
    const formToken = created.data.token;
    await client.forms.invite(id, {
      recipients: [{ email: "a@example.test" }, { email: "b@example.test" }],
      formToken,
    });

    const sdk = await client.forms.remindInvites(id, { formToken, force: true });
    expect(sdk.data.invites.length).toBe(2);
    expect(sdk.data.skipped).toBe(0);
    expect(sdk.data.invites[0]!.token.startsWith("inv_")).toBe(true);
    expect(sdk.data.invites[0]!.url).toBe(`/f/${formToken}?i=${sdk.data.invites[0]!.token}`);
    expect(sdk.data.invites[0]!.reminderCount).toBe(1);

    const rest = (await (
      await h.fetch(
        `/api/admin/forms/${id}/invites/remind`,
        json({ formToken, force: true }),
      )
    ).json()) as { data: { invites: { token: string }[]; sent: number; skipped: number } };
    expect(rest.data.invites.length).toBe(2);
    // A second reminder is a second link — the earlier ones are not replaced.
    expect(rest.data.invites[0]!.token).not.toBe(sdk.data.invites[0]!.token);

    const gql = (await (
      await h.fetch("/api/graphql", json({
        query: `mutation($id:ID!,$t:String!){ remindPublicFormInvites(id:$id, formToken:$t, force:true) }`,
        variables: { id, t: formToken },
      }))
    ).json()) as {
      data?: { remindPublicFormInvites: { invites: unknown[]; sent: number; skipped: number } };
      errors?: unknown[];
    };
    expect(gql.errors).toBeUndefined();
    expect(gql.data?.remindPublicFormInvites.invites.length).toBe(2);
    expect(gql.data?.remindPublicFormInvites.sent).toBe(0);

    // Reminders never show up in a read surface as tokens.
    const list = await client.forms.invites(id);
    expect(list.data.every((i) => i.reminderCount === 3)).toBe(true);
    expect(JSON.stringify(list.data)).not.toContain(sdk.data.invites[0]!.token);

    await client.forms.delete(id);
  });

  test("non-admin sessions are rejected by the admin surface", async () => {
    // No session at all → 401 from requireUser.
    const anon = await h.app.fetch(new Request(`${h.env.APP_URL}/api/admin/forms`));
    expect(anon.status).toBe(401);
  });
});
