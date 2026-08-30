/**
 * The MCP Tasks extension — a durable handle for work that outlives a
 * connection.
 *
 * The implementation's whole claim is that this server did not need a task
 * table: the ids address `agent_runs` and the job queue, which are already
 * durable and tenant-scoped. These tests hold that claim to its consequences —
 * the status mapping, the opt-in gate, and above all that a task id cannot be
 * used to learn whether another workspace's run exists.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  TASKS_EXTENSION,
  clientWantsTasks,
  taskIdForJob,
  taskIdForRun,
} from "../src/server/mcp/tasks";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const MODERN = "2026-07-28";

const rpc = async (h: TestHarness, method: string, params?: unknown, caps?: unknown) => {
  const res = await h.fetch("/mcp", {
    method: "POST",
    headers: { ...JSON_HEADERS, "mcp-protocol-version": MODERN, "mcp-method": method },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...(params ?? {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          ...(caps ? { "io.modelcontextprotocol/clientCapabilities": caps } : {}),
        },
      },
    }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

describe("tasks — the opt-in gate", () => {
  test("a client that declared the extension wants tasks", () => {
    expect(
      clientWantsTasks({
        params: {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { [TASKS_EXTENSION]: {} },
            },
          },
        },
      }),
    ).toBe(true);
  });

  test("everything else does not", () => {
    // A `CreateTaskResult` is a DIFFERENT result shape. Handing one to a client
    // that did not ask reads as a failed call, or worse as the answer — so the
    // default has to be no, for every shape of missing.
    expect(clientWantsTasks({ params: {} })).toBe(false);
    expect(clientWantsTasks({})).toBe(false);
    expect(
      clientWantsTasks({
        params: { _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: {} } } },
      }),
    ).toBe(false);
    expect(
      clientWantsTasks({
        params: {
          _meta: {
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { "io.modelcontextprotocol/ui": {} },
            },
          },
        },
      }),
    ).toBe(false);
  });
});

describe("tasks — over the wire", () => {
  let h: TestHarness;
  let jobId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/jobs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ type: "webhook.deliver", payload: {} }),
    });
    jobId = ((await res.json()) as { id?: string }).id ?? "";
  });
  afterAll(() => h.cleanup());

  test("server/discover advertises the extension", async () => {
    const { body } = await rpc(h, "server/discover");
    // `toHaveProperty` reads dots as a path, and the extension id is full of
    // them — so ask for the key itself rather than a path that does not exist.
    expect(Object.keys(body.result.capabilities.extensions)).toContain(TASKS_EXTENSION);
  });

  test("a real job resolves as a task with a poll interval and a TTL", async () => {
    expect(jobId).not.toBe("");
    const { body } = await rpc(h, "tasks/get", { taskId: taskIdForJob(jobId) });
    expect(body.error).toBeUndefined();
    expect(body.result.taskId).toBe(taskIdForJob(jobId));
    // A queued job is live work, not a terminal state.
    expect(body.result.status).toBe("working");
    expect(body.result.pollIntervalMs).toBeGreaterThan(0);
    expect(body.result.ttlMs).toBeGreaterThan(0);
    // Live tasks carry neither of the terminal fields.
    expect(body.result.result).toBeUndefined();
    expect(body.result.error).toBeUndefined();
  });

  test("an unknown task id is a parameter error, not a server error", async () => {
    const { body } = await rpc(h, "tasks/get", { taskId: "job:does-not-exist" });
    expect(body.error.code).toBe(-32602);
  });

  test("a malformed handle is refused rather than guessed at", async () => {
    for (const bad of ["", "nokind", "unknown:1", "job:"]) {
      const { body } = await rpc(h, "tasks/get", { taskId: bad });
      expect(`${bad}: ${body.error?.code}`).toBe(`${bad}: -32602`);
    }
  });

  test("ANOTHER workspace's task answers exactly like an unknown one", async () => {
    // The security property. If a foreign id said "forbidden" while an invented
    // one said "unknown", a task id would be a probe for whether a run exists.
    const other = makeHarness();
    try {
      await seedAdmin(other);
      const res = await other.fetch("/api/jobs", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ type: "webhook.deliver", payload: {} }),
      });
      const foreign = ((await res.json()) as { id: string }).id;

      const mine = await rpc(h, "tasks/get", { taskId: taskIdForJob(foreign) });
      const invented = await rpc(h, "tasks/get", { taskId: taskIdForJob("00000000-0000-0000-0000-000000000000") });
      expect(mine.body.error.code).toBe(invented.body.error.code);
      expect(mine.status).toBe(invented.status);
    } finally {
      other.cleanup();
    }
  });

  test("tasks/update acknowledges rather than refusing", async () => {
    // We surface no `inputRequests`, so nothing is outstanding. The spec says to
    // acknowledge and ignore unknown keys; refusing would strand a conforming
    // client that always sends them.
    const { body } = await rpc(h, "tasks/update", {
      taskId: taskIdForJob(jobId),
      inputResponses: { whatever: { ok: true } },
    });
    expect(body.error).toBeUndefined();
    expect(body.result.resultType).toBe("complete");
  });

  test("tasks/cancel is cooperative — it acknowledges even where it cannot stop the work", async () => {
    // An agent turn is deliberately not cancellable: its tool calls already
    // happened. The client still gets an ack, per the contract.
    const { body } = await rpc(h, "tasks/cancel", { taskId: taskIdForRun("no-such-run") });
    expect(body.error).toBeUndefined();
  });

  test("cancelling a real job actually cancels it", async () => {
    const res = await h.fetch("/api/jobs", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ type: "webhook.deliver", payload: {} }),
    });
    const id = ((await res.json()) as { id: string }).id;
    await rpc(h, "tasks/cancel", { taskId: taskIdForJob(id) });
    const { body } = await rpc(h, "tasks/get", { taskId: taskIdForJob(id) });
    expect(body.result.status).toBe("cancelled");
  });
});
