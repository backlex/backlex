/**
 * `GET /api/admin/settings/runtime` — the Settings → Environment / Bindings
 * tabs.
 *
 * The route had no spec at all. It is the one admin endpoint whose entire job
 * is to talk ABOUT secrets: it walks `AUTH_SECRET`, `DATABASE_URL`,
 * `RESEND_API_KEY`, `SENDGRID_API_KEY` and the rest, and answers whether each
 * is set. Reporting presence is the feature; reporting the value would be a
 * credential disclosure to anyone who reaches the admin API — including an API
 * key scoped narrowly enough that its holder was never meant to read the
 * deploy's secrets.
 *
 * The assertion that matters is therefore a NEGATIVE one, and a negative
 * assertion only has force in the state where the forbidden value would
 * otherwise appear. Run against the default harness this file would be
 * theatre: `RESEND_API_KEY`, `SMTP_PASSWORD`, `OPENAI_API_KEY` and the rest are
 * all unset there, so `not.toContain` would hold over a response that had no
 * chance of carrying them. So the harness is built with every secret populated
 * with a distinctive sentinel first, and the first test proves the endpoint
 * actually SAW them — a run where the values never reached the handler passes
 * the leak check for the wrong reason.
 *
 * Verified 2026-08-30 by adding `value: env.OPENAI_API_KEY` to the inventory
 * row: the leak test goes red naming the key. See the repo's standing note on
 * this shape — an approvals endpoint leaked every approver's email past a
 * `not.toContain` that ran with nobody having decided yet.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/** Distinctive enough that a substring hit cannot be a coincidence, and shaped
 *  like the real thing so nothing rejects it as malformed on the way in. */
const SECRETS = {
  AUTH_SECRET: "auth-secret-leak-canary-9f2c0a7e1d",
  RESEND_API_KEY: "re_leakcanary_8817bfa0",
  SENDGRID_API_KEY: "SG.leakcanary.4410ffc2",
  SMTP_PASSWORD: "smtp-pw-4bd1f7-leakcanary",
  OPENAI_API_KEY: "sk-leakcanary-0d41b8e2",
  SANDBOX_RPC_TOKEN: "sbx-leakcanary-77ac13",
} as const;

// `DATABASE_URL` is deliberately NOT in the set. It is the one "secret" on this
// inventory that also SELECTS an adapter: setting it flips `buildContext` to
// the Postgres dialect and the harness then dials a host that does not exist.
// Its row is asserted separately below, against a deploy that genuinely has no
// value for it.

let h: TestHarness;

beforeAll(async () => {
  h = makeHarness(SECRETS as unknown as Record<string, string>);
  await seedAdmin(h);
});
afterAll(() => h.cleanup());

const runtime = () => h.fetch("/api/admin/settings/runtime");

describe("GET /api/admin/settings/runtime", () => {
  test("reports the deploy's shape, and the secrets really are loaded", async () => {
    const res = await runtime();
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { envVars?: { key: string; set: boolean; secret: boolean }[] };
    };

    // Liveness for everything below. If the handler answered with an empty or
    // renamed inventory, every `not.toContain` in the next test would hold
    // over a response that could not have leaked anything.
    const byKey = new Map((data.envVars ?? []).map((e) => [e.key, e]));
    for (const key of Object.keys(SECRETS)) {
      expect(`${key} reported: ${byKey.has(key)}`).toBe(`${key} reported: true`);
      expect(`${key} set: ${byKey.get(key)?.set}`).toBe(`${key} set: true`);
      // The flag the admin UI uses to mask the row. A secret that arrives
      // flagged `secret: false` is rendered in the clear by the client even
      // when the server withheld the value.
      expect(`${key} flagged secret: ${byKey.get(key)?.secret}`).toBe(
        `${key} flagged secret: true`,
      );
    }
  });

  test("answers whether a secret is set, never what it is", async () => {
    const body = await (await runtime()).text();
    for (const [key, value] of Object.entries(SECRETS)) {
      expect(`${key} value in body: ${body.includes(value)}`).toBe(
        `${key} value in body: false`,
      );
    }
    // The distinguishing fragment of every canary on its own, so a handler
    // that "redacted" a value by truncating or reformatting it — rather than
    // withholding it — still fails.
    expect(body).not.toContain("leakcanary");
    expect(body).not.toContain("4bd1f7");
  });

  test("an unset secret reads as absent rather than as an empty string", async () => {
    // `DATABASE_URL` is the negative control: the same code path over a key
    // this deploy has no value for. `present()` treats "" and undefined alike,
    // and a row answering `set: true` for a missing var would send an operator
    // hunting a connection that does not exist.
    const { data } = (await (await runtime()).json()) as {
      data: { envVars?: { key: string; set: boolean }[] };
    };
    const row = (data.envVars ?? []).find((e) => e.key === "DATABASE_URL");
    expect(`DATABASE_URL reported: ${Boolean(row)}`).toBe("DATABASE_URL reported: true");
    expect(`DATABASE_URL set: ${row?.set}`).toBe("DATABASE_URL set: false");
  });

  test("a signed-out caller gets nothing", async () => {
    // The inventory names which providers a deploy is wired to, which is
    // reconnaissance even without the values.
    const res = await h.app.request(
      "/api/admin/settings/runtime",
      { headers: { origin: h.env.APP_URL as string } },
      h.env,
    );
    expect(res.status).toBe(401);
  });
});
