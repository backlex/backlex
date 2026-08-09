/**
 * Multi-surface parity for S3 credentials.
 *
 * One invariant matters more than the rest and is asserted on every surface:
 * the secret is returned exactly once, by `create`, and appears nowhere else.
 * A surface that leaked it would undo the reason the stored copy is encrypted
 * at all.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { s3Tools } from "../src/server/mcp/tools/s3";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };

describe("S3 credentials — surfaces", () => {
  let h: TestHarness;
  let secret = "";
  let id = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/admin/s3-credentials", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "parity", prefix: "p/", readOnly: true }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; prefix: string; readOnly: boolean };
      secretAccessKey: string;
    };
    secret = body.secretAccessKey;
    id = body.data.id;
    expect(body.data.prefix).toBe("p/");
    expect(body.data.readOnly).toBe(true);
  });
  afterAll(() => h.cleanup());

  test("the secret is not in the list, and there is no read-back route", async () => {
    const listed = await (await h.fetch("/api/admin/s3-credentials")).text();
    expect(listed).not.toContain(secret);
    // There is deliberately no `GET /{id}` that could return it — an endpoint
    // that decrypted on request would undo the at-rest encryption for anyone
    // who reaches the admin API.
    const single = await h.fetch(`/api/admin/s3-credentials/${id}`);
    expect(single.status).toBe(404);
  });

  test("the secret is not in the activity log either", async () => {
    const log = await (await h.fetch("/api/activity?limit=50")).text();
    expect(log).not.toContain(secret);
  });

  test("credential routes are admin-only", async () => {
    const anon = (path: string, init?: RequestInit) =>
      h.app.request(
        path,
        { ...init, headers: { origin: "http://localhost:5173" } } as RequestInit,
        h.env,
      );
    expect((await anon("/api/admin/s3-credentials")).status).toBeGreaterThanOrEqual(400);
    expect(
      (await anon("/api/admin/s3-credentials", { method: "POST" })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  test("every REST verb has an MCP tool, and create warns that the secret is one-shot", () => {
    expect(s3Tools.map((t) => t.name).sort()).toEqual([
      "s3.create_credential",
      "s3.delete_credential",
      "s3.list_credentials",
      "s3.update_credential",
    ]);
    const create = s3Tools.find((t) => t.name === "s3.create_credential")!;
    expect(create.description).toContain("ONCE");
  });

  test("the SDK points at routes that exist", async () => {
    const { makeS3 } = await import("../../../packages/client/src/clients/s3");
    const calls: string[] = [];
    const core = {
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        return {} as never;
      },
    } as never;
    const s3 = makeS3(core);
    await s3.list();
    await s3.create({ name: "x" });
    await s3.update(id, { enabled: false });
    await s3.delete(id);
    expect(calls).toEqual([
      "GET /api/admin/s3-credentials",
      "POST /api/admin/s3-credentials",
      `PATCH /api/admin/s3-credentials/${id}`,
      `DELETE /api/admin/s3-credentials/${id}`,
    ]);
    // Dispatched for real against the LIVE id, so a 404 means the route is not
    // mounted rather than "that row does not exist" — the failure this catches
    // is an SDK pointed at a path nobody registered, which typechecks
    // perfectly and fails only in a customer's terminal.
    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      const res = await h.fetch(path, {
        method,
        headers: JSON_HEADERS,
        ...(method === "POST" || method === "PATCH"
          ? { body: JSON.stringify({ name: "probe" }) }
          : {}),
      });
      expect(res.status).not.toBe(404);
    }
  });

  test("a prefix that could climb out of its own scope is refused", async () => {
    const res = await h.fetch("/api/admin/s3-credentials", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "escape", prefix: "../other/" }),
    });
    expect(res.status).toBe(422);
  });
});
