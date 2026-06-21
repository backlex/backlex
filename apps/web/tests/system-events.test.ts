import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { recordAndRunBackup } from "../src/server/services/backup";
import { processJobsWithEnv } from "../src/server/services/jobs";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

interface JobView {
  id: string;
  type: string;
  status: string;
}

const pollWebhookJobs = async (h: TestHarness): Promise<JobView[]> => {
  let jobs: JobView[] = [];
  for (let i = 0; i < 30 && jobs.length === 0; i++) {
    const res = await h.fetch("/api/jobs?queue=webhooks");
    jobs = ((await res.json()) as { jobs: JobView[] }).jobs;
    if (jobs.length === 0) await new Promise((r) => setTimeout(r, 15));
  }
  return jobs;
};

describe("system event alerts (DLQ + backup)", () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  const tick = () => processJobsWithEnv(h.env);

  test("a dead-lettered job fans out a system:job.dead_letter webhook", async () => {
    const fn = await h.fetch(
      "/api/functions",
      json({
        name: "boom_fn",
        trigger: "http",
        pattern: null,
        code: "throw new Error('always fails');",
        timeoutMs: 5000,
        active: true,
      }),
    );
    expect(fn.status).toBe(201);

    // Operator alert hook subscribed to the dead-letter system event.
    const hook = await h.fetch(
      "/api/webhooks",
      json({
        name: "dlq-alert",
        url: "http://127.0.0.1:1/never",
        events: ["system:job.dead_letter"],
        active: true,
      }),
    );
    expect(hook.status).toBe(201);

    // One-shot job → dead-letters on the first tick.
    const enq = await h.fetch(
      "/api/jobs",
      json({ type: "function", payload: { name: "boom_fn" }, maxAttempts: 1 }),
    );
    expect(enq.status).toBe(200);

    await tick();

    // The dead-letter must have published system:job.dead_letter, which
    // dispatched a webhook.deliver job for the alert hook.
    const webhookJobs = await pollWebhookJobs(h);
    expect(webhookJobs.length).toBeGreaterThanOrEqual(1);
    expect(webhookJobs[0]?.type).toBe("webhook.deliver");
  });

  test("a dead-lettered webhook.deliver does NOT re-publish (no alert loop)", async () => {
    const hook = await h.fetch(
      "/api/webhooks",
      json({
        name: "loopy",
        url: "http://127.0.0.1:1/never",
        events: ["system:job.dead_letter"],
        active: true,
      }),
    );
    expect(hook.status).toBe(201);
    const webhookId = ((await hook.json()) as { data: { id: string } }).data.id;

    const enq = await h.fetch(
      "/api/jobs",
      json({
        type: "webhook.deliver",
        queue: "webhooks",
        payload: { webhookId, channel: "items:x", event: "created", body: "{}" },
        maxAttempts: 1,
      }),
    );
    expect(enq.status).toBe(200);
    const deliverId = ((await enq.json()) as { id: string }).id;

    await tick();

    // It dead-letters, but because the dead-lettered job is itself a
    // webhook.deliver, no new system event is published → no extra
    // webhook.deliver job is spawned (would otherwise loop while the endpoint
    // stays down). Give any stray fan-out a moment to land before asserting.
    await new Promise((r) => setTimeout(r, 60));
    const res = await h.fetch("/api/jobs?queue=webhooks");
    const jobs = ((await res.json()) as { jobs: JobView[] }).jobs;
    const spawned = jobs.filter((j) => j.id !== deliverId);
    expect(spawned.length).toBe(0);
  });

  test("a failed backup returns ok:false and fans out system:backup.failed", async () => {
    const hook = await h.fetch(
      "/api/webhooks",
      json({
        name: "backup-alert",
        url: "http://127.0.0.1:1/never",
        events: ["system:backup.failed"],
        active: true,
      }),
    );
    expect(hook.status).toBe(201);

    // Force a backup failure by breaking the storage write the dump relies on.
    const ctx = await buildContext(h.env);
    (ctx as unknown as { storage: { put: unknown } }).storage = {
      ...ctx.storage,
      put: async () => {
        throw new Error("storage offline");
      },
    };

    const r = await recordAndRunBackup(ctx, {
      id: crypto.randomUUID(),
      tenantId: null,
      storageKey: "backups/global/test.jsonl",
      userId: null,
      label: "Test",
    });
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toContain("storage offline");

    // The failure published system:backup.failed → webhook.deliver enqueued.
    const webhookJobs = await pollWebhookJobs(h);
    expect(webhookJobs.length).toBeGreaterThanOrEqual(1);
    expect(webhookJobs[0]?.type).toBe("webhook.deliver");
  });
});
