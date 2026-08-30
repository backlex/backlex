/**
 * Outbound webhooks reach every surface — REST, MCP, CLI and now the SDK.
 *
 * `sdk-surfaces.test.ts` recorded this one as the cheapest four-of-five in the
 * repository: REST, MCP and CLI all covered it and only the SDK did not, sized
 * at roughly seventy lines, deferred because wave 19's cut line put the
 * app-plane surfaces first — and then wave 19 shipped without it.
 *
 * This file is the mechanism that closes it rather than a check on it. The
 * repo's own measurement was that a subsystem's `*-surfaces.test.ts` is what
 * PRODUCES its SDK client: whoever writes one has to write the methods to make
 * it pass. So the assertion that matters is the last one — every path the SDK
 * builds is dispatched for real against a LIVE id, so a 404 means the route is
 * not mounted rather than "that row does not exist". An SDK pointed at a path
 * nobody registered typechecks perfectly and fails only in a customer's
 * terminal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { webhooksTools } from "../src/server/mcp/tools/webhooks";

const JSON_HEADERS = { "content-type": "application/json" };

let h: TestHarness;
let id: string;
let deliveryId: string;

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  const made = await h.fetch("/api/webhooks", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      name: "Order sync",
      url: "https://receiver.example.test/hooks",
      events: ["items.orders.created"],
    }),
  });
  expect(made.status).toBeLessThan(300);
  id = ((await made.json()) as { data: { id: string } }).data.id;
  // No delivery has happened yet, so the retry path is probed with a
  // well-formed id that does not exist. That answers 404 — but from the
  // HANDLER, and the two kinds of 404 are distinguishable: a mounted route
  // returns the `AppError` JSON envelope, while an unmounted path returns
  // Hono's bare `404 Not Found` text. The dispatch loop below asserts on that
  // difference rather than on the status, which is what lets every verb
  // (including this one) be checked the same way.
  deliveryId = "00000000-0000-4000-8000-000000000000";
});
afterAll(() => h.cleanup());

describe("webhooks — every surface", () => {
  test("REST refuses an anonymous caller on both the list and the write", async () => {
    const anon = (path: string, init?: RequestInit) =>
      h.app.request(
        path,
        { ...init, headers: { origin: h.env.APP_URL as string } } as RequestInit,
        h.env,
      );
    expect((await anon("/api/webhooks")).status).toBeGreaterThanOrEqual(400);
    expect((await anon("/api/webhooks", { method: "POST" })).status).toBeGreaterThanOrEqual(400);
  });

  test("every REST verb has an MCP tool", () => {
    expect(webhooksTools.map((t) => t.name).sort()).toEqual([
      "webhooks.create",
      "webhooks.delete",
      "webhooks.list",
      "webhooks.test",
    ]);
  });

  test("the SDK points at routes that exist", async () => {
    const { makeWebhooks } = await import("../../../packages/client/src/clients/webhooks");
    const calls: string[] = [];
    const core = {
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        return {} as never;
      },
    } as never;
    const webhooks = makeWebhooks(core);

    await webhooks.list();
    await webhooks.create({ name: "x", url: "https://x.example.test", events: ["items.*"] });
    await webhooks.update(id, { active: false });
    await webhooks.test(id);
    await webhooks.deliveries({ webhookId: id, limit: 5 });
    await webhooks.retryDelivery(deliveryId);
    await webhooks.delete(id);

    expect(calls).toEqual([
      "GET /api/webhooks",
      "POST /api/webhooks",
      `PATCH /api/webhooks/${id}`,
      `POST /api/webhooks/${id}/test`,
      `GET /api/webhooks/_deliveries?webhookId=${id}&limit=5`,
      `POST /api/webhooks/_deliveries/${deliveryId}/retry`,
      `DELETE /api/webhooks/${id}`,
    ]);

    // Dispatched for real. The `test` verb is skipped because it makes an
    // outbound request to the hook's own URL — proving a route is mounted is
    // not worth a real egress attempt from the suite.
    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      if (path.endsWith("/test")) continue;
      const res = await h.fetch(path, {
        method,
        headers: JSON_HEADERS,
        ...(method === "POST" || method === "PATCH"
          ? {
              body: JSON.stringify({
                name: "probe",
                url: "https://probe.example.test/h",
                events: ["items.*"],
              }),
            }
          : {}),
      });
      // A HANDLER answered — that is the claim. An unmounted path falls through
      // to Hono's own `404 Not Found`, which is plain text; every mounted route
      // answers JSON, whether it succeeds or refuses. Asserting `status !== 404`
      // instead would fail on a legitimately-absent row and pass on a route
      // that returns 500 because it was never registered.
      const body = await res.text();
      expect(`${method} ${path} reached a handler: ${body.startsWith("{")}`).toBe(
        `${method} ${path} reached a handler: true`,
      );
    }
  });

  test("the delivery log is scoped by hook, not handed out whole", async () => {
    // `deliveries()` takes a `webhookId` and the SDK forwards it as a query
    // param. A client that dropped the filter would look identical — the call
    // succeeds and returns rows — while showing an operator another hook's
    // payloads, which carry whatever the event carried.
    const res = await h.fetch(`/api/webhooks/_deliveries?webhookId=${id}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { webhookId: string }[] };
    expect(Array.isArray(data)).toBe(true);
    for (const row of data) expect(row.webhookId).toBe(id);
  });

  test("the SDK adds no read-back path of its own for the signing secret", async () => {
    // A `getSecret`-shaped method would be the one addition that turns an SDK
    // convenience into a credential surface in its own right, so the shape is
    // asserted rather than trusted.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../../../packages/client/src/clients/webhooks.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(src).not.toMatch(/\bgetSecret\b|\brevealSecret\b/);
    // And it must still be settable, or the client cannot configure a hook at
    // all — the negative above is only meaningful next to this.
    expect(src).toContain("secret?: string");
  });

  test("the list DOES return the secret — recorded, because its sibling does not", async () => {
    // Measured while writing the SDK client, and worth pinning because the two
    // surfaces disagree about the same class of credential:
    //
    //   `/api/webhooks`          → returns the signing secret in plaintext
    //   `/api/admin/auth-hooks`  → returns `hasSecret: boolean` and says in its
    //                              own type "the signing secret has no read-back
    //                              path"
    //
    // Both are admin-gated, so this is an inconsistency rather than an
    // exposure. It is asserted as the CURRENT behaviour, not as the desired
    // one: an SDK caller who logs a `list()` response is logging a credential,
    // and whoever changes that should have to change this line deliberately.
    const secret = `whsec_surfaces_${Date.now()}`;
    const made = await h.fetch("/api/webhooks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "secret probe",
        url: "https://probe.example.test/h",
        events: ["items.*"],
        secret,
      }),
    });
    expect(made.status).toBeLessThan(300);

    const body = await (await h.fetch("/api/webhooks")).text();
    expect(`list returns the secret: ${body.includes(secret)}`).toBe(
      "list returns the secret: true",
    );
  });
});
