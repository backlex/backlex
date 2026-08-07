import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Invite links — the shape that makes "one answer per person" mean a person.
 *
 * The cookie guard beside this is a courtesy; an invite is a count. So what is
 * under test is mostly what must NOT happen: a token spent twice, an invite to
 * one form opening another, a token appearing in a list response, and a
 * submission that failed validation quietly eating someone's only link.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("form invites", () => {
  let h: TestHarness;
  const slug = `invited_${Date.now()}`;
  let formId = "";
  let formToken = "";

  const publicFetch = (path: string, init?: RequestInit) =>
    h.app.fetch(new Request(`${h.env.APP_URL}${path}`, init));

  const mint = async (
    body: Record<string, unknown>,
    id = formId,
  ): Promise<{ status: number; invites: { id: string; token: string; url: string; email: string | null }[]; sent: number }> => {
    const res = await h.fetch(`/api/admin/forms/${id}/invites`, json(body));
    if (res.status !== 201) return { status: res.status, invites: [], sent: 0 };
    const parsed = (await res.json()) as {
      data: { invites: { id: string; token: string; url: string; email: string | null }[]; sent: number };
    };
    return { status: res.status, ...parsed.data };
  };

  const submit = (data: Record<string, unknown>, invite?: string) =>
    publicFetch(
      `/api/public/forms/${formToken}/submit`,
      json({ data, ...(invite ? { invite } : {}) }),
    );

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "answer", type: "text", required: true },
          { name: "note", type: "text" },
        ],
      }),
    );
    expect(created.status).toBe(201);

    const form = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Staff survey",
        collection: slug,
        fields: [{ name: "answer" }, { name: "note" }],
        settings: { inviteOnly: true },
      }),
    );
    expect(form.status).toBe(201);
    const body = (await form.json()) as { data: { form: { id: string }; token: string } };
    formId = body.data.form.id;
    formToken = body.data.token;
  });

  afterAll(() => h.cleanup());

  test("an invite-only form turns away a visitor without one", async () => {
    const res = await publicFetch(`/api/public/forms/${formToken}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { closed: { reason: string; message: string } | null };
    };
    expect(body.data.closed?.reason).toBe("invite");
    expect(body.data.closed?.message).toContain("invited");

    expect((await submit({ answer: "sneaking in" })).status).toBe(410);
    // …and a made-up token is turned away the same way, without saying which
    // part of it was wrong.
    expect((await submit({ answer: "guessing" }, "inv_deadbeef")).status).toBe(410);
  });

  test("minting returns the links once, and the list never repeats them", async () => {
    const { status, invites } = await mint({
      recipients: [{ email: "ada@example.test", name: "Ada" }, { name: "Paper handout" }],
      formToken,
    });
    expect(status).toBe(201);
    expect(invites.length).toBe(2);
    expect(invites[0]!.token.startsWith("inv_")).toBe(true);
    expect(invites[0]!.url).toBe(`/f/${formToken}?i=${invites[0]!.token}`);
    // A recipient with no address is allowed — a workshop hands links out.
    expect(invites[1]!.email).toBeNull();

    const list = await h.fetch(`/api/admin/forms/${formId}/invites`);
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { data: Record<string, unknown>[] }).data;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect("token" in row).toBe(false);
      expect("tokenHash" in row).toBe(false);
    }
    expect(JSON.stringify(rows)).not.toContain(invites[0]!.token);
  });

  test("a link works once and only once", async () => {
    const { invites } = await mint({ recipients: [{ email: "grace@example.test" }], formToken });
    const token = invites[0]!.token;

    const def = await publicFetch(`/api/public/forms/${formToken}?i=${token}`);
    const defBody = (await def.json()) as { data: { closed: unknown } };
    expect(defBody.data.closed).toBeNull();

    expect((await submit({ answer: "my answer" }, token)).status).toBe(201);

    const second = await submit({ answer: "again" }, token);
    expect(second.status).toBe(410);
    const err = (await second.json()) as { error: { message: string } };
    expect(err.error.message).toContain("already been used");

    // The page says so before anyone fills the form in a second time.
    const after = await publicFetch(`/api/public/forms/${formToken}?i=${token}`);
    const afterBody = (await after.json()) as { data: { closed: { reason: string } | null } };
    expect(afterBody.data.closed?.reason).toBe("invite_used");

    const list = await h.fetch(`/api/admin/forms/${formId}/invites`);
    const rows = ((await list.json()) as { data: { id: string; usedAt: unknown }[] }).data;
    expect(rows.find((r) => r.id === invites[0]!.id)?.usedAt).not.toBeNull();
  });

  test("a rejected submission hands the invite back", async () => {
    const { invites } = await mint({ recipients: [{ email: "alan@example.test" }], formToken });
    const token = invites[0]!.token;

    // `answer` is required by the collection, so this write fails validation.
    const bad = await submit({ note: "forgot the answer" }, token);
    expect(bad.status).toBe(422);

    // The link must still work — a missed field is a mistake to correct, not a
    // door that locks behind you.
    const good = await submit({ answer: "second time lucky" }, token);
    expect(good.status).toBe(201);
  });

  test("an invite to one form does not open another", async () => {
    const other = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Customer survey",
        collection: slug,
        fields: [{ name: "answer" }],
        settings: { inviteOnly: true },
      }),
    );
    const otherBody = (await other.json()) as { data: { form: { id: string }; token: string } };
    const { invites } = await mint({ recipients: [{ email: "x@example.test" }], formToken });

    const res = await publicFetch(
      `/api/public/forms/${otherBody.data.token}/submit`,
      json({ data: { answer: "wrong door" }, invite: invites[0]!.token }),
    );
    expect(res.status).toBe(410);
  });

  test("a revoked invite stops working", async () => {
    const { invites } = await mint({ recipients: [{ email: "revoked@example.test" }], formToken });
    const del = await h.fetch(`/api/admin/forms/${formId}/invites/${invites[0]!.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect((await submit({ answer: "too late" }, invites[0]!.token)).status).toBe(410);
  });

  test("a form that is not invite-only ignores invites entirely", async () => {
    const open = await h.fetch(
      "/api/admin/forms",
      json({ name: "Open form", collection: slug, fields: [{ name: "answer" }] }),
    );
    const openToken = ((await open.json()) as { data: { token: string } }).data.token;
    const res = await publicFetch(
      `/api/public/forms/${openToken}/submit`,
      json({ data: { answer: "no invite needed" } }),
    );
    expect(res.status).toBe(201);
  });

  test("invites are refused for a form in another workspace", async () => {
    const res = await h.fetch(`/api/admin/forms/does-not-exist/invites`, json({
      recipients: [{ email: "nobody@example.test" }],
    }));
    expect(res.status).toBe(404);
  });

  /* ── reminders ───────────────────────────────────────────────────── */

  const remind = async (
    body: Record<string, unknown> = {},
    id = formId,
  ): Promise<{
    status: number;
    invites: { id: string; token: string; url: string; email: string | null }[];
    sent: number;
    skipped: number;
    message: string;
  }> => {
    const res = await h.fetch(`/api/admin/forms/${id}/invites/remind`, json(body));
    const text = await res.text();
    if (res.status !== 200)
      return { status: res.status, invites: [], sent: 0, skipped: 0, message: text };
    const parsed = JSON.parse(text) as {
      data: {
        invites: { id: string; token: string; url: string; email: string | null }[];
        sent: number;
        skipped: number;
      };
    };
    return { status: res.status, ...parsed.data, message: text };
  };

  test("a reminder adds a link without taking the first one away", async () => {
    const one = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Reminded survey",
        collection: slug,
        fields: [{ name: "answer" }],
        settings: { inviteOnly: true },
      }),
    );
    const { form, token } = ((await one.json()) as {
      data: { form: { id: string }; token: string };
    }).data;
    const first = await mint({ recipients: [{ email: "ada@example.test" }], formToken: token }, form.id);
    const original = first.invites[0]!.token;

    const nudged = await remind({ formToken: token, force: true }, form.id);
    expect(nudged.status).toBe(200);
    expect(nudged.invites.length).toBe(1);
    const reminder = nudged.invites[0]!.token;
    expect(reminder).not.toBe(original);
    expect(nudged.invites[0]!.id).toBe(first.invites[0]!.id);

    const answer = (invite: string, value: string) =>
      publicFetch(
        `/api/public/forms/${token}/submit`,
        json({ data: { answer: value }, invite }),
      );

    // BOTH links open the form — the person being reminded is precisely the
    // person whose first link must not break.
    for (const t of [original, reminder]) {
      const def = await publicFetch(`/api/public/forms/${token}?i=${t}`);
      expect(((await def.json()) as { data: { closed: unknown } }).data.closed).toBeNull();
    }

    // …and they are one turn, not two: spending either spends it.
    expect((await answer(original, "answered once")).status).toBe(201);
    expect((await answer(reminder, "and again")).status).toBe(410);

    const list = await h.fetch(`/api/admin/forms/${form.id}/invites`);
    const rows = ((await list.json()) as {
      data: { usedAt: unknown; remindedAt: unknown; reminderCount: number }[];
    }).data;
    expect(rows[0]!.usedAt).not.toBeNull();
    expect(rows[0]!.reminderCount).toBe(1);
    expect(rows[0]!.remindedAt).not.toBeNull();
    // No token, ever, in a read response.
    expect(JSON.stringify(rows)).not.toContain(reminder);
  });

  test("nobody who has answered is reminded, and nobody twice too soon", async () => {
    const one = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Paced reminders",
        collection: slug,
        fields: [{ name: "answer" }],
        settings: { inviteOnly: true },
      }),
    );
    const { form, token } = ((await one.json()) as {
      data: { form: { id: string }; token: string };
    }).data;
    const { invites } = await mint(
      { recipients: [{ email: "a@example.test" }, { email: "b@example.test" }], formToken: token },
      form.id,
    );
    // One of the two answers.
    expect(
      (
        await publicFetch(
          `/api/public/forms/${token}/submit`,
          json({ data: { answer: "done" }, invite: invites[0]!.token }),
        )
      ).status,
    ).toBe(201);

    const first = await remind({ formToken: token }, form.id);
    expect(first.invites.length).toBe(1);
    expect(first.invites[0]!.email).toBe("b@example.test");
    // The one who answered is counted as left alone, not as reminded.
    expect(first.skipped).toBe(1);

    // A second nudge a moment later reminds nobody: the default interval is a
    // day, and a reminder that arrives every time an operator opens the panel
    // is a reminder nobody reads.
    const second = await remind({ formToken: token }, form.id);
    expect(second.invites.length).toBe(0);
    expect(second.skipped).toBe(2);

    // Unless the operator says so.
    expect((await remind({ formToken: token, force: true }, form.id)).invites.length).toBe(1);
    // …or asks for a shorter gap.
    expect(
      (await remind({ formToken: token, minIntervalHours: 0 }, form.id)).invites.length,
    ).toBe(1);
  });

  test("a form nobody can answer refuses to remind anyone", async () => {
    const one = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Closed survey",
        collection: slug,
        fields: [{ name: "answer" }],
        settings: { inviteOnly: true, closesAt: Date.now() - 60_000 },
      }),
    );
    const { form, token } = ((await one.json()) as {
      data: { form: { id: string }; token: string };
    }).data;
    await mint({ recipients: [{ email: "late@example.test" }], formToken: token }, form.id);

    const res = await remind({ formToken: token, force: true }, form.id);
    expect(res.status).toBe(422);
    expect(res.message).toContain("not taking answers");

    // A paused form is refused too, and says which thing is wrong.
    const paused = await h.fetch(`/api/admin/forms/${form.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false, settings: { inviteOnly: true } }),
    });
    expect(paused.status).toBe(200);
    const res2 = await remind({ formToken: token, force: true }, form.id);
    expect(res2.status).toBe(422);
    expect(res2.message).toContain("paused");
  });

  test("revoking an invite kills every link into it", async () => {
    const one = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Revoked after reminding",
        collection: slug,
        fields: [{ name: "answer" }],
        settings: { inviteOnly: true },
      }),
    );
    const { form, token } = ((await one.json()) as {
      data: { form: { id: string }; token: string };
    }).data;
    const { invites } = await mint(
      { recipients: [{ email: "gone@example.test" }], formToken: token },
      form.id,
    );
    const nudged = await remind({ formToken: token, force: true }, form.id);
    const reminder = nudged.invites[0]!.token;

    const del = await h.fetch(`/api/admin/forms/${form.id}/invites/${invites[0]!.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    for (const t of [invites[0]!.token, reminder]) {
      const res = await publicFetch(
        `/api/public/forms/${token}/submit`,
        json({ data: { answer: "too late" }, invite: t }),
      );
      expect(res.status).toBe(410);
    }
  });

  test("the batch has a ceiling, said out loud", async () => {
    const res = await h.fetch(
      `/api/admin/forms/${formId}/invites`,
      json({ recipients: Array.from({ length: 501 }, () => ({ email: "a@b.test" })) }),
    );
    // Rejected by the schema before the service ever sees 501 rows.
    expect(res.status).toBe(422);
  });
});
