/**
 * Multi-surface parity for the durable job queue.
 *
 * What every surface has to agree on: a job's life cycle is driven by the
 * queue and not by the caller. `runAt` is the only way to place a job in the
 * future, `retry` is the only way to give a failed one another attempt, and
 * neither `status` nor `attempts` is settable from outside — a caller who
 * could write `attempts` could exhaust a job's budget without it ever having
 * run, or reset a poison job into an endless loop.
 *
 * The delete/remove asymmetry is deliberate and pinned here: the SDK spells it
 * `remove` because `delete` is a reserved word in the positions a generated
 * binding puts it in, while REST and MCP keep the verb.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { jobsTools } from "../src/server/mcp/tools/jobs";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const BASE = "/api/jobs";

/** Far enough out that the queue cannot pick it up mid-test. */
const LATER = new Date(Date.now() + 60 * 60 * 1000).toISOString();

describe("jobs — surfaces", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

    // A `function` job names a function that has to exist — the enqueue
    // endpoint resolves it up front so a typo fails at the call rather than
    // an hour later in a worker log.
    const fn = await h.fetch("/api/functions", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "noop",
        trigger: "http",
        pattern: null,
        code: "export default async () => ({ ok: true });",
        timeoutMs: 5000,
        active: true,
      }),
    });
    expect(fn.status).toBe(201);
  });

  afterAll(() => h.close?.());

  test("REST: enqueue, read back, cancel", async () => {
    const res = await h.fetch(BASE, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        type: "function",
        payload: { name: "noop", input: {} },
        runAt: LATER,
      }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(id).toBeTruthy();

    const one = (await (await h.fetch(`${BASE}/${id}`)).json()) as {
      job?: { status: string; attempts: number };
      status?: string;
    };
    // The envelope differs between builds; what matters is that a freshly
    // enqueued future job has not run.
    const status = one.job?.status ?? one.status;
    expect(status).toBe("pending");

    expect((await h.fetch(`${BASE}/${id}/cancel`, { method: "POST" })).status).toBe(200);
  });

  test("REST: status and attempts are not caller-writable", async () => {
    const res = await h.fetch(BASE, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        type: "function",
        payload: { name: "noop" },
        runAt: LATER,
        status: "completed",
        attempts: 99,
      }),
    });
    // Either refused outright or accepted with the extra keys dropped — what
    // must not happen is a job that starts life having already "run".
    if (res.status === 200) {
      const { id } = (await res.json()) as { id: string };
      const body = (await (await h.fetch(`${BASE}/${id}`)).json()) as {
        job?: { status: string; attempts: number };
        status?: string;
        attempts?: number;
      };
      expect(body.job?.status ?? body.status).toBe("pending");
      expect(body.job?.attempts ?? body.attempts).toBe(0);
    } else {
      expect(res.status).toBe(422);
    }
  });

  test("MCP: the five tools an agent gets, and none of them deletes", () => {
    expect(jobsTools.map((t) => t.name).sort()).toEqual([
      "jobs.cancel",
      "jobs.enqueue",
      "jobs.get",
      "jobs.list",
      "jobs.retry",
    ]);
  });

  test("the SDK points at routes that exist", async () => {
    const calls: string[] = [];
    const spy = {
      request: async (m: string, p: string) => {
        calls.push(`${m} ${p}`);
        return { id: "spy" };
      },
    };
    const { makeJobs } = await import("../../../packages/client/src/clients/jobs");
    const jobs = makeJobs(spy as never);
    // A LIVE id, so a 404 below means the route is unmounted rather than "no
    // such row" — the failure this catches is an SDK pointed at a path nobody
    // registered, which typechecks perfectly.
    const live = (
      await client.jobs.enqueue({
        type: "function",
        payload: { name: "noop", input: {} },
        runAt: LATER,
      })
    ).id;

    await jobs.enqueue({ type: "function" });
    await jobs.list();
    await jobs.get(live);
    await jobs.retry(live);
    await jobs.cancel(live);
    await jobs.remove(live);
    expect(calls).toEqual([
      "POST /api/jobs",
      "GET /api/jobs",
      `GET /api/jobs/${live}`,
      `POST /api/jobs/${live}/retry`,
      `POST /api/jobs/${live}/cancel`,
      `DELETE /api/jobs/${live}`,
    ]);

    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      const res = await h.fetch(path, {
        method,
        headers: JSON_HEADERS,
        ...(method === "POST" && path === BASE
          ? { body: JSON.stringify({ type: "function", payload: { name: "noop" }, runAt: LATER }) }
          : {}),
      });
      expect(`${call} → ${res.status}`).not.toContain("404");
    }
  });

  test("SDK: the round trip an application actually makes", async () => {
    const { id } = await client.jobs.enqueue({
      type: "function",
      payload: { name: "noop", input: {} },
      runAt: LATER,
      queue: "parity",
    });
    expect(id).toBeTruthy();

    const listed = await client.jobs.list({ queue: "parity" });
    expect(listed.jobs.some((j) => j.id === id)).toBe(true);

    expect((await client.jobs.cancel(id)).ok).toBe(true);
    expect((await client.jobs.remove(id)).ok).toBe(true);
  });
});
