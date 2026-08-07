import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * The provider-config singletons (`ai_config`, `email_config`, `push_config`,
 * `sms_config`) are one row per workspace keyed on `tenant_id`, and their admin
 * endpoints used to write them with a check-then-act: SELECT, then branch to
 * INSERT or UPDATE.
 *
 * That is a race with a window. Two concurrent saves for a workspace that has
 * no row yet both read "nothing there" and both INSERT; the loser hits
 * `UNIQUE constraint failed` and the caller gets a 500. It is not theoretical —
 * the identical shape was found and fixed in `app_settings` after a
 * concurrent-write load test turned it up in production (routes/settings.ts),
 * and these four never got that fix. `services/provider-config.ts` now writes
 * them through a single ON CONFLICT statement, so there is no window to lose.
 *
 * Each case fires the first save for a workspace CONCURRENTLY. Verified to fail
 * against the check-then-act version — the second request 500s.
 */

const PROVIDERS = [
  {
    name: "push-config",
    path: "/api/admin/push-config",
    body: { provider: "fcm", config: { projectId: "p1", clientEmail: "svc@p1.iam" } },
    expect: "fcm",
  },
  {
    name: "sms-config",
    path: "/api/admin/sms-config",
    body: { provider: "twilio", config: { accountSid: "AC1", from: "+15550001111" } },
    expect: "twilio",
  },
  {
    name: "email-config",
    path: "/api/admin/email-config",
    body: { provider: "resend", fromAddress: "no-reply@example.com", config: {} },
    expect: "resend",
  },
] as const;

describe("provider config: the first save is atomic", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  for (const p of PROVIDERS) {
    test(`${p.name}: concurrent first saves both succeed`, async () => {
      const save = () =>
        h.fetch(p.path, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(p.body),
        });

      const results = await Promise.all([save(), save(), save()]);
      // Not "at least one succeeded" — every one of them must, because none of
      // them asked for anything another could legitimately refuse.
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);

      const get = await h.fetch(p.path);
      const cfg = (await get.json()) as { data: { provider: string } };
      expect(cfg.data.provider).toBe(p.expect);
    });
  }

  /**
   * The other half of the upsert's contract: a save that omits a column must
   * leave that column alone on an existing row, rather than resetting it to the
   * value a fresh INSERT would have used. That is what the `always` / `onCreate`
   * split in `saveOwnConfigRow` exists for, and it is the part a single
   * `.values({...})` would silently get wrong.
   */
  test("a later save that omits `config` keeps the stored one", async () => {
    const put = (body: unknown) =>
      h.fetch("/api/admin/push-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await put({ provider: "fcm", config: { projectId: "keep-me" } })).status).toBe(200);
    // Same provider, no `config` key at all.
    expect((await put({ provider: "fcm" })).status).toBe(200);

    const cfg = (await (await h.fetch("/api/admin/push-config")).json()) as {
      data: { config: Record<string, unknown> };
    };
    expect(cfg.data.config.projectId).toBe("keep-me");
  });

  /**
   * And the secrets blob: a key the patch does not mention keeps its stored
   * value, so an admin form can re-save without re-typing a secret it is never
   * allowed to display back.
   */
  test("a later save that omits a secret keeps it set", async () => {
    const put = (body: unknown) =>
      h.fetch("/api/admin/push-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    await put({
      provider: "fcm",
      config: { projectId: "p1" },
      secrets: { privateKey: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----" },
    });
    await put({ provider: "fcm", config: { projectId: "p2" } });

    const cfg = (await (await h.fetch("/api/admin/push-config")).json()) as {
      data: { secretsSet: { privateKey: boolean }; config: Record<string, unknown> };
    };
    expect(cfg.data.secretsSet.privateKey).toBe(true);
    expect(cfg.data.config.projectId).toBe("p2");
    expect(JSON.stringify(cfg.data)).not.toContain("BEGIN PRIVATE KEY");
  });
});
