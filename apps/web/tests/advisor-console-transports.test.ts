/**
 * The three transports that can report a message as sent and send nothing.
 *
 * Email had a finding; SMS and push did not, and they are the sharper edge.
 * `consoleSms` answers `{ sent: msg.to.length, failed: 0 }` and `consolePush`
 * answers `{ sent: msg.tokens.length, failed: 0, invalidTokens: [] }` — which
 * is byte-for-byte what a real provider returns on a perfect delivery. So the
 * API response, the activity row and the usage counters all agree that the
 * messages went out, and nothing anywhere disagrees. A workspace can ship a
 * notification feature, watch it report 100 %, and have sent nothing at all.
 *
 * The other half of this file is the false positive, which is the harder part
 * to get right and the one this repo has now got wrong twice: on a managed
 * cloud project `buildContext` swaps the console adapter for the control-plane
 * gateway, so the finding would be describing a fallback that cannot happen.
 * That is a different judgement from `sec-backups-off`, where being a cloud
 * tenant genuinely does not tell you whether backups are taken — hence the
 * separate `CLOUD_MANAGED_BACKUPS` signal there. Ask what the platform does,
 * not who the tenant is.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

interface Finding {
  id: string;
  level: "error" | "warn" | "info";
  rule: string;
  body: string;
}

/** The env a managed cloud tenant actually carries — all three parts are
 *  required for `cloudConfigured` (secret + project id + a way to reach the
 *  control plane), and a partial set must NOT count as managed. */
const CLOUD_ENV = {
  CLOUD_PROJECT_ID: "proj_advisor",
  CLOUD_REPORT_SECRET: "s3cret-for-tests-only",
  CLOUD_REPORT_URL: "https://cloud.invalid",
};

const findings = async (h: TestHarness): Promise<Finding[]> => {
  const res = await h.fetch("/api/admin/advisor");
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Finding[] }).data;
};

const ids = (f: Finding[]): string[] => f.map((x) => x.id);

describe("advisor — console transports", () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  test("a self-hosted install with no credentials is warned about all three", async () => {
    h = makeHarness();
    await seedAdmin(h);
    const found = await findings(h);
    expect(ids(found)).toContain("sec-email-console-fallback");
    expect(ids(found)).toContain("sec-sms-console-fallback");
    expect(ids(found)).toContain("sec-push-console-fallback");

    // SMS and push are `warn` where email is `info`, and the difference is the
    // point: an undelivered verification mail is noticed by the person waiting
    // for it; a console SMS actively asserts that it was delivered.
    const byId = Object.fromEntries(found.map((f) => [f.id, f]));
    expect(byId["sec-email-console-fallback"]!.level).toBe("info");
    expect(byId["sec-sms-console-fallback"]!.level).toBe("warn");
    expect(byId["sec-push-console-fallback"]!.level).toBe("warn");
    // The body has to say the thing that makes this dangerous, not just that a
    // provider is missing — otherwise it reads as "you have not set this up
    // yet", which is how a finding gets ignored.
    expect(byId["sec-sms-console-fallback"]!.body).toContain("reports every recipient as sent");
  });

  test("real SMS credentials silence the SMS finding and nothing else", async () => {
    h = makeHarness({
      TWILIO_ACCOUNT_SID: "AC_test",
      TWILIO_AUTH_TOKEN: "tok_test",
      TWILIO_FROM: "+15550000000",
    });
    await seedAdmin(h);
    const found = ids(await findings(h));
    expect(found).not.toContain("sec-sms-console-fallback");
    // Proven non-vacuous by its neighbours: the other two still fire, so the
    // absence above is the credentials and not the advisor having gone quiet.
    expect(found).toContain("sec-push-console-fallback");
    expect(found).toContain("sec-email-console-fallback");
  });

  test("real push credentials silence the push finding and nothing else", async () => {
    h = makeHarness({
      FCM_PROJECT_ID: "proj",
      FCM_CLIENT_EMAIL: "svc@example.test",
      FCM_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
    });
    await seedAdmin(h);
    const found = ids(await findings(h));
    expect(found).not.toContain("sec-push-console-fallback");
    expect(found).toContain("sec-sms-console-fallback");
  });

  test("an explicit console provider is still a console fallback", async () => {
    // Choosing `console` deliberately does not make the messages arrive. The
    // rule keys on the spec that would actually run, not on whether anyone
    // meant it.
    h = makeHarness({ SMS_PROVIDER: "console", PUSH_PROVIDER: "console" });
    await seedAdmin(h);
    const found = ids(await findings(h));
    expect(found).toContain("sec-sms-console-fallback");
    expect(found).toContain("sec-push-console-fallback");
  });

  test("incomplete credentials count as console, because that is what runs", async () => {
    // Half a Twilio config resolves to `console` in `selectSmsSpec` — with a
    // warning nobody reads. This is the case most likely to be mistaken for
    // "configured", so it must be findable.
    h = makeHarness({ TWILIO_ACCOUNT_SID: "AC_test" });
    await seedAdmin(h);
    expect(ids(await findings(h))).toContain("sec-sms-console-fallback");
  });

  test("a managed cloud project is not warned — the gateway is what runs there", async () => {
    h = makeHarness(CLOUD_ENV);
    await seedAdmin(h);
    const found = ids(await findings(h));
    expect(found).not.toContain("sec-email-console-fallback");
    expect(found).not.toContain("sec-sms-console-fallback");
    expect(found).not.toContain("sec-push-console-fallback");
    // Not vacuous: the advisor still ran and still has things to say about this
    // workspace, so the three absences are the cloud skip and not an empty
    // result. `sec-backups-off` is the neighbour that deliberately does NOT
    // skip on tenancy alone.
    expect(found.length).toBeGreaterThan(0);
    expect(found).toContain("sec-backups-off");
  });

  test("a passthrough image adapter is reported, and an edge backend excuses it", async () => {
    const { runAdvisorChecks } = await import("../src/server/services/advisor");
    h = makeHarness();
    await seedAdmin(h);
    const { buildContext } = await import("../src/server/context");
    const ctx = await buildContext(h.env);
    const base = { db: ctx.db, dialect: ctx.dialect, env: ctx.env };

    // Driven directly rather than through the endpoint, because the adapter
    // that loads depends on the host this suite happens to run on — and the
    // rule is about what the adapter IS, not about what this machine has.
    const passthrough = await runAdvisorChecks(
      { ...base, image: { name: "passthrough" } },
      "default",
    );
    expect(passthrough.data.map((f) => f.id)).toContain("perf-image-passthrough");

    // A real transformer: nothing to say.
    const real = await runAdvisorChecks({ ...base, image: { name: "bun-image" } }, "default");
    expect(real.data.map((f) => f.id)).not.toContain("perf-image-passthrough");

    // Passthrough BEHIND an edge backend is the normal Cloudflare/Netlify
    // shape — the CDN resizes and the in-process adapter is never reached.
    const edge = await runAdvisorChecks(
      { ...base, image: { name: "passthrough" }, edgeImage: { name: "cf-image" } },
      "default",
    );
    expect(edge.data.map((f) => f.id)).not.toContain("perf-image-passthrough");

    // And a caller that gave no image says nothing, rather than guessing.
    const unknown = await runAdvisorChecks(base, "default");
    expect(unknown.data.map((f) => f.id)).not.toContain("perf-image-passthrough");
  });

  test("a HALF-configured cloud channel is not a managed project", async () => {
    // `cloudConfigured` needs the secret, the project id AND a route to the
    // control plane. A project id alone is what a stale env or a
    // partly-provisioned tenant looks like, and treating it as managed would
    // silence the finding for an install whose messages really do go nowhere.
    h = makeHarness({ CLOUD_PROJECT_ID: "proj_advisor" });
    await seedAdmin(h);
    const found = ids(await findings(h));
    expect(found).toContain("sec-sms-console-fallback");
    expect(found).toContain("sec-push-console-fallback");
  });
});
