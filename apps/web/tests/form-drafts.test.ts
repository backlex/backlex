import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Coming back to a half-filled form.
 *
 * The behaviour under test is one promise — "close this and come back" — and
 * the three ways it can quietly break: saving for a form that never asked to,
 * handing a draft to the wrong visitor, and keeping one after the form was
 * submitted. Each of those looks fine in a browser and is wrong in a way
 * nobody notices until it matters.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("form drafts", () => {
  let h: TestHarness;
  let client: Database;
  const slug = `draft_${Date.now()}`;

  const publicFetch = (path: string, init?: RequestInit) =>
    h.app.fetch(new Request(`${h.env.APP_URL}${path}`, init));

  const makeForm = async (
    name: string,
    settings: Record<string, unknown>,
    fields: Array<Record<string, unknown>> = [{ name: "answer" }, { name: "note" }],
  ): Promise<{ id: string; token: string }> => {
    const res = await h.fetch("/api/admin/forms", json({ name, collection: slug, fields, settings }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { form: { id: string }; token: string } };
    return { id: body.data.form.id, token: body.data.token };
  };

  const saveDraft = (
    token: string,
    body: Record<string, unknown>,
    cookie?: string,
  ) =>
    publicFetch(`/api/public/forms/${token}/draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  const definition = async (token: string, cookie?: string, invite?: string) => {
    const res = await publicFetch(
      `/api/public/forms/${token}${invite ? `?i=${invite}` : ""}`,
      cookie ? { headers: { cookie } } : undefined,
    );
    return {
      status: res.status,
      body: (await res.json()) as {
        data?: {
          saveProgress: boolean;
          draft: { data: Record<string, unknown>; step: number; savedAt: number } | null;
        };
      },
    };
  };

  /** The `blx_fp_…` cookie a save minted, in `name=value` form. */
  const draftCookie = (res: Response): string => {
    const raw = res.headers.get("set-cookie") ?? "";
    expect(raw).toContain("blx_fp_");
    return raw.split(";")[0]!;
  };

  beforeAll(async () => {
    h = makeHarness();
    client = new Database(h.env.SQLITE_PATH as string);
    await seedAdmin(h);
    const created = await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "answer", type: "text" },
          { name: "note", type: "text" },
        ],
      }),
    );
    expect(created.status).toBe(201);
  });

  afterAll(() => {
    client.close();
    h.cleanup();
  });

  const draftRows = (formId: string): number =>
    (
      client
        .query("SELECT COUNT(*) AS n FROM form_drafts WHERE form_id = ?")
        .get(formId) as { n: number } | null
    )?.n ?? 0;

  test("a form that saves progress hands the answers back on the next visit", async () => {
    const { token } = await makeForm("Long survey", { saveProgress: true });

    const saved = await saveDraft(token, { data: { answer: "half" }, step: 1 });
    expect(saved.status).toBe(200);
    const cookie = draftCookie(saved);
    // The cookie carries a secret, so it must not be readable by the page that
    // set it — nor be the form's own token wearing a different name.
    expect(saved.headers.get("set-cookie")).toContain("HttpOnly");
    expect(saved.headers.get("set-cookie")).not.toContain(token);

    const back = await definition(token, cookie);
    expect(back.body.data?.saveProgress).toBe(true);
    expect(back.body.data?.draft?.data).toEqual({ answer: "half" });
    expect(back.body.data?.draft?.step).toBe(1);

    // …and a visitor without the cookie starts from a blank form.
    const stranger = await definition(token);
    expect(stranger.body.data?.draft).toBeNull();
  });

  test("saving again replaces the draft instead of forking it", async () => {
    const { token } = await makeForm("Replaced", { saveProgress: true });
    const first = await saveDraft(token, { data: { answer: "one" }, step: 0 });
    const cookie = draftCookie(first);

    const second = await saveDraft(token, { data: { answer: "two", note: "n" }, step: 2 }, cookie);
    expect(second.status).toBe(200);
    // A second save through an existing cookie must not mint another one —
    // that would strand the first draft behind a key nobody holds any more.
    expect(second.headers.get("set-cookie") ?? "").not.toContain("blx_fp_");

    const back = await definition(token, cookie);
    expect(back.body.data?.draft?.data).toEqual({ answer: "two", note: "n" });
    expect(back.body.data?.draft?.step).toBe(2);
  });

  test("a form that did not ask to save progress refuses to", async () => {
    const { token } = await makeForm("No saving", {});
    const res = await saveDraft(token, { data: { answer: "x" } });
    expect(res.status).toBe(422);
    // …and its definition says so, so the page never tries.
    const { body } = await definition(token);
    expect(body.data?.saveProgress).toBe(false);
    expect(body.data?.draft).toBeNull();
  });

  test("only exposed fields are kept, and file blocks never are", async () => {
    const { token } = await makeForm("Clamped", { saveProgress: true });
    const saved = await saveDraft(token, {
      data: { answer: "kept", secret_admin_note: "dropped", id: "nope" },
    });
    expect(saved.status).toBe(200);
    const back = await definition(token, draftCookie(saved));
    expect(back.body.data?.draft?.data).toEqual({ answer: "kept" });
  });

  test("submitting throws the draft away", async () => {
    const { token } = await makeForm("Finished", { saveProgress: true });
    const saved = await saveDraft(token, { data: { answer: "nearly" } });
    const cookie = draftCookie(saved);

    const submitted = await publicFetch(`/api/public/forms/${token}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ data: { answer: "done" } }),
    });
    expect(submitted.status).toBe(201);

    // Not "the page moved on" — the row itself is gone, because it is the same
    // personal data as the submission, kept where nothing would read it.
    const back = await definition(token, cookie);
    expect(back.body.data?.draft).toBeNull();
  });

  test("start over clears the saved answers", async () => {
    const { token } = await makeForm("Restart", { saveProgress: true });
    const saved = await saveDraft(token, { data: { answer: "regret" } });
    const cookie = draftCookie(saved);

    const cleared = await publicFetch(`/api/public/forms/${token}/draft`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(cleared.status).toBe(200);
    const back = await definition(token, cookie);
    expect(back.body.data?.draft).toBeNull();
  });

  test("a closed form neither saves nor resumes", async () => {
    const { id, token } = await makeForm("Over", { saveProgress: true });
    const saved = await saveDraft(token, { data: { answer: "in time" } });
    const cookie = draftCookie(saved);

    // Close it after the fact — the draft is real, the form is over.
    const patch = await h.fetch(`/api/admin/forms/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { saveProgress: true, closesAt: Date.now() - 1000 } }),
    });
    expect(patch.status).toBe(200);

    const late = await saveDraft(token, { data: { answer: "too late" } }, cookie);
    expect(late.status).toBe(410);
    // The page shows the closed message, not a form pre-filled with answers
    // nobody can submit.
    const back = await definition(token, cookie);
    expect(back.body.data?.draft).toBeNull();
  });

  test("an invited person's draft follows their link, not their browser", async () => {
    const { id, token } = await makeForm("Invited", { saveProgress: true, inviteOnly: true });
    const minted = await h.fetch(
      `/api/admin/forms/${id}/invites`,
      json({ recipients: [{ email: "ada@example.test" }, { email: "grace@example.test" }] }),
    );
    expect(minted.status).toBe(201);
    const invites = ((await minted.json()) as { data: { invites: { token: string }[] } }).data
      .invites;
    const [ada, grace] = [invites[0]!.token, invites[1]!.token];

    const saved = await saveDraft(token, { data: { answer: "ada's" }, step: 1, invite: ada });
    expect(saved.status).toBe(200);
    // No cookie: the link IS the key, which is what lets the phone that started
    // the survey and the laptop that finishes it be the same person.
    expect(saved.headers.get("set-cookie") ?? "").not.toContain("blx_fp_");

    // A different browser, same link → the answers are there.
    const resumed = await definition(token, undefined, ada);
    expect(resumed.body.data?.draft?.data).toEqual({ answer: "ada's" });

    // Grace's link is a different key and must not see Ada's answers.
    const other = await definition(token, undefined, grace);
    expect(other.body.data?.draft).toBeNull();
  });

  test("deleting the form deletes the half-filled answers with it", async () => {
    const { id, token } = await makeForm("Doomed", { saveProgress: true });
    const saved = await saveDraft(token, { data: { answer: "orphan" } });
    const cookie = draftCookie(saved);
    expect((await definition(token, cookie)).body.data?.draft?.data).toEqual({
      answer: "orphan",
    });

    // Loaded state first: the row is really there, so the assertion below
    // can't pass because nothing was ever written.
    expect(draftRows(id)).toBe(1);

    const del = await h.fetch(`/api/admin/forms/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    // The form's token is gone, so the table is the only place the leftovers
    // would show — which is exactly why the delete has to reach them.
    expect(draftRows(id)).toBe(0);
  });

  test("the results panel counts the ones still in progress", async () => {
    const { id, token } = await makeForm("Counted", { saveProgress: true });
    await saveDraft(token, { data: { answer: "a" } });
    await saveDraft(token, { data: { answer: "b" } });

    const res = await h.fetch(`/api/admin/forms/${id}/results`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { inProgress: number } };
    // Two saves through two cookie-less requests are two visitors.
    expect(data.inProgress).toBe(2);
  });
});
