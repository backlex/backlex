import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { processJobsWithEnv } from "../src/server/services/jobs";

const JSON_HEADERS = { "Content-Type": "application/json" };
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

interface JobView {
  id: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  queue: string;
  type: string;
}

describe("Durable job queue", () => {
  let h: TestHarness;

  beforeEach(async () => {
    // Low cap + zero backoff so retries fire on the very next tick.
    h = makeHarness({ JOB_MAX_ATTEMPTS: "3", JOB_BACKOFF_BASE_MS: "0" });
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  const createFunction = async (name: string, code: string) => {
    const res = await h.fetch("/api/functions", json({
      name,
      trigger: "http",
      pattern: null,
      code,
      timeoutMs: 5000,
      active: true,
    }));
    expect(res.status).toBe(201);
  };

  const enqueue = async (body: unknown): Promise<string> => {
    const res = await h.fetch("/api/jobs", json(body));
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  };

  const getJob = async (id: string): Promise<JobView> => {
    const res = await h.fetch(`/api/jobs/${id}`);
    expect(res.status).toBe(200);
    return (await res.json()) as JobView;
  };

  const tick = () => processJobsWithEnv(h.env);

  test("enqueue a function job → tick drains it to succeeded", async () => {
    await createFunction("ok_job", "return { done: true };");
    const id = await enqueue({ type: "function", payload: { name: "ok_job", input: {} } });
    expect((await getJob(id)).status).toBe("pending");
    await tick();
    const job = await getJob(id);
    expect(job.status).toBe("succeeded");
    expect(job.attempts).toBe(1);
  });

  test("a failing function retries then dead-letters after maxAttempts", async () => {
    await createFunction("fail_job", "throw new Error('boom');");
    const id = await enqueue({ type: "function", payload: { name: "fail_job" } });

    await tick();
    let job = await getJob(id);
    expect(job.status).toBe("pending"); // requeued
    expect(job.attempts).toBe(1);
    expect(job.lastError ?? "").toContain("boom");

    await tick();
    expect((await getJob(id)).attempts).toBe(2);

    await tick();
    job = await getJob(id);
    expect(job.status).toBe("dead_letter");
    expect(job.attempts).toBe(3);
  });

  test("a delayed job is not run before runAt", async () => {
    await createFunction("later_job", "return 1;");
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const id = await enqueue({ type: "function", payload: { name: "later_job" }, runAt: future });
    await tick();
    const job = await getJob(id);
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
  });

  test("cancel prevents a pending job from running", async () => {
    await createFunction("cancel_job", "return 1;");
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const id = await enqueue({ type: "function", payload: { name: "cancel_job" }, runAt: future });
    const cancel = await h.fetch(`/api/jobs/${id}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    expect((await getJob(id)).status).toBe("cancelled");
    await tick();
    expect((await getJob(id)).status).toBe("cancelled");
  });

  test("retry requeues a dead-lettered job", async () => {
    await createFunction("retry_job", "throw new Error('nope');");
    const id = await enqueue({ type: "function", payload: { name: "retry_job" } });
    await tick(); await tick(); await tick();
    expect((await getJob(id)).status).toBe("dead_letter");

    const retry = await h.fetch(`/api/jobs/${id}/retry`, { method: "POST" });
    expect(retry.status).toBe(200);
    const job = await getJob(id);
    expect(job.status).toBe("pending");
    expect(job.attempts).toBe(0);
  });

  test("a terminal job is not re-run on the next tick", async () => {
    await createFunction("once_job", "return 1;");
    const id = await enqueue({ type: "function", payload: { name: "once_job" } });
    await tick();
    expect((await getJob(id)).status).toBe("succeeded");
    await tick(); // succeeded jobs are not eligible
    expect((await getJob(id)).attempts).toBe(1);
  });

  test("enqueue requires authentication", async () => {
    const anon = makeHarness();
    try {
      const res = await anon.fetch("/api/jobs", json({ type: "function", payload: { name: "x" } }));
      expect(res.status).toBe(401);
    } finally {
      anon.cleanup();
    }
  });

  test("enqueueing a function job for a missing function is rejected", async () => {
    const res = await h.fetch("/api/jobs", json({ type: "function", payload: { name: "ghost" } }));
    expect(res.status).toBe(422); // AppError VALIDATION
  });

  test("an item write enqueues a webhook.deliver job (not delivered inline)", async () => {
    const slug = `wh_${Date.now()}`;
    const col = await h.fetch("/api/collections", json({
      slug,
      ownerScoped: false,
      fields: [{ name: "title", type: "text" }],
    }));
    expect(col.status).toBe(201);
    const hook = await h.fetch("/api/webhooks", json({
      name: "test-hook",
      url: "http://127.0.0.1:1/never",
      events: [`items:${slug}:*`],
      active: true,
    }));
    expect(hook.status).toBe(201);

    const item = await h.fetch(`/api/items/${slug}`, json({ title: "hello" }));
    expect([200, 201]).toContain(item.status);

    // dispatchWebhooks is fire-and-forget; poll briefly for the enqueued job.
    let jobs: JobView[] = [];
    for (let i = 0; i < 20 && jobs.length === 0; i++) {
      const res = await h.fetch("/api/jobs?queue=webhooks");
      jobs = ((await res.json()) as { jobs: JobView[] }).jobs;
      if (jobs.length === 0) await new Promise((r) => setTimeout(r, 15));
    }
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0]?.type).toBe("webhook.deliver");
  });

  test("a webhook.deliver job to a dead endpoint retries and dead-letters", async () => {
    const hook = await h.fetch("/api/webhooks", json({
      name: "dead-hook",
      url: "http://127.0.0.1:1/never",
      events: ["items:x:*"],
      active: true,
    }));
    expect(hook.status).toBe(201);
    const webhookId = ((await hook.json()) as { data: { id: string } }).data.id;

    const id = await enqueue({
      type: "webhook.deliver",
      queue: "webhooks",
      payload: { webhookId, channel: "items:x", event: "created", body: "{}" },
    });
    await tick(); await tick(); await tick();
    expect((await getJob(id)).status).toBe("dead_letter");

    // Each attempt records a (failed) delivery row.
    const del = await h.fetch(`/api/webhooks/_deliveries?webhookId=${webhookId}`);
    const deliveries = ((await del.json()) as { data: unknown[] }).data;
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
  });
});
