import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * When a form stops taking answers, and what it says when it has.
 *
 * The distinction under test is between PAUSED and CLOSED. A paused form is
 * switched off and answers 410 with nothing else; a form that closed on its own
 * terms still renders — it has a title and a reason, which is what the person
 * following the link came for. Getting that backwards turns "the survey ended
 * on Friday" into a broken link.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const HOUR = 3_600_000;

describe("form availability", () => {
  let h: TestHarness;
  const slug = `avail_${Date.now()}`;

  const publicFetch = (path: string, init?: RequestInit) =>
    h.app.fetch(new Request(`${h.env.APP_URL}${path}`, init));

  /** Mint a form with the given settings; returns its id + public token. */
  const makeForm = async (
    name: string,
    settings: Record<string, unknown>,
  ): Promise<{ id: string; token: string }> => {
    const res = await h.fetch(
      "/api/admin/forms",
      json({ name, collection: slug, fields: [{ name: "answer" }], settings }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { form: { id: string }; token: string } };
    return { id: body.data.form.id, token: body.data.token };
  };

  const definition = async (token: string) => {
    const res = await publicFetch(`/api/public/forms/${token}`);
    return {
      status: res.status,
      body: (await res.json()) as {
        data?: { name: string; closed: { reason: string; message: string } | null };
      },
    };
  };

  const submit = (token: string, data: Record<string, unknown>, cookie?: string) =>
    publicFetch(`/api/public/forms/${token}/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ data }),
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await h.fetch(
      "/api/collections",
      json({ slug, fields: [{ name: "answer", type: "text" }] }),
    );
    expect(created.status).toBe(201);
  });

  afterAll(() => h.cleanup());

  test("a form that hasn't opened yet renders, and refuses answers", async () => {
    const { token } = await makeForm("Not yet", { opensAt: Date.now() + HOUR });
    const { status, body } = await definition(token);
    // 200, not 404: the link is real and the page has something to say.
    expect(status).toBe(200);
    expect(body.data?.name).toBe("Not yet");
    expect(body.data?.closed?.reason).toBe("scheduled");
    expect(body.data?.closed?.message).toContain("isn't open yet");

    const res = await submit(token, { answer: "too early" });
    expect(res.status).toBe(410);
  });

  test("a closed form uses the operator's own wording", async () => {
    const { token } = await makeForm("Ended", {
      closesAt: Date.now() - 1000,
      closedMessage: "Voting closed on Friday. Thanks to everyone who took part.",
    });
    const { body } = await definition(token);
    expect(body.data?.closed?.reason).toBe("ended");
    expect(body.data?.closed?.message).toBe(
      "Voting closed on Friday. Thanks to everyone who took part.",
    );
    const res = await submit(token, { answer: "late" });
    expect(res.status).toBe(410);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toContain("Voting closed on Friday");
  });

  test("a still-open window takes answers", async () => {
    const { token } = await makeForm("Open window", {
      opensAt: Date.now() - HOUR,
      closesAt: Date.now() + HOUR,
    });
    const { body } = await definition(token);
    expect(body.data?.closed).toBeNull();
    expect((await submit(token, { answer: "on time" })).status).toBe(201);
  });

  test("a schedule that closes before it opens is refused at design time", async () => {
    const now = Date.now();
    const res = await h.fetch(
      "/api/admin/forms",
      json({
        name: "Impossible",
        collection: slug,
        fields: [{ name: "answer" }],
        settings: { opensAt: now + HOUR, closesAt: now },
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("close before it opens");
  });

  test("the response limit closes the form once it is reached", async () => {
    const { token } = await makeForm("Capped", { maxResponses: 2 });
    expect((await submit(token, { answer: "one" })).status).toBe(201);
    expect((await definition(token)).body.data?.closed).toBeNull();
    expect((await submit(token, { answer: "two" })).status).toBe(201);

    const third = await submit(token, { answer: "three" });
    expect(third.status).toBe(410);
    const { body } = await definition(token);
    expect(body.data?.closed?.reason).toBe("full");
    expect(body.data?.closed?.message).toContain("response limit");
  });

  test("one answer per browser is a cookie the second visit carries", async () => {
    const { token } = await makeForm("Once", { onePerBrowser: true });
    const first = await submit(token, { answer: "mine" });
    expect(first.status).toBe(201);
    const setCookie = first.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("blx_fa_");
    expect(setCookie).toContain("HttpOnly");
    // The name must not be the form id — a cookie is the one place a page
    // hands its own storage to whoever is looking.
    expect(setCookie).not.toContain(token);

    const cookie = setCookie.split(";")[0]!;
    const second = await submit(token, { answer: "again" }, cookie);
    expect(second.status).toBe(410);

    const answered = await publicFetch(`/api/public/forms/${token}`, {
      headers: { cookie },
    });
    const body = (await answered.json()) as {
      data: { closed: { reason: string } | null };
    };
    expect(body.data.closed?.reason).toBe("answered");

    // …and a browser that never answered still sees the questions.
    const fresh = await definition(token);
    expect(fresh.body.data?.closed).toBeNull();
  });

  test("the cookie is only read when the form asked for it", async () => {
    // A form WITHOUT the setting must ignore an answered cookie — including
    // one another form on the same origin set.
    const { token } = await makeForm("Unlimited", {});
    const first = await submit(token, { answer: "a" });
    expect(first.status).toBe(201);
    expect(first.headers.get("set-cookie") ?? "").not.toContain("blx_fa_");
    expect((await submit(token, { answer: "b" })).status).toBe(201);
  });

  test("paused still beats every closing rule", async () => {
    const { id, token } = await makeForm("Paused", { closesAt: Date.now() + HOUR });
    const patch = await h.fetch(`/api/admin/forms/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    expect(patch.status).toBe(200);
    // 410 with the paused wording, not a rendered "closed" page: a paused form
    // is switched off, and its link was not supposed to be in circulation.
    const res = await publicFetch(`/api/public/forms/${token}`);
    expect(res.status).toBe(410);
  });
});
