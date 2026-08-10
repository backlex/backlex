/**
 * Multi-surface parity for signing keys.
 *
 * The invariant that matters on every surface: no private key comes back, not
 * even from `generate`. Unlike an API key, nobody ever needs to hold one — it
 * exists to sign, its public half is published, and the only legitimate copy is
 * the row. A surface that returned it would be handing out the ability to mint
 * tokens for the whole instance.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signingKeysTools } from "../src/server/mcp/tools/signing-keys";
import { KEY_STATUSES } from "../src/server/services/signing-keys";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const BASE = "/api/admin/signing-keys";

describe("signing keys — surfaces", () => {
  let h: TestHarness;
  let id = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch(BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "parity" }),
    });
    expect(res.status).toBe(201);
    id = ((await res.json()) as { data: { id: string } }).data.id;
  });
  afterAll(() => h.cleanup());

  test("no surface returns a private key", async () => {
    for (const path of [BASE]) {
      const raw = await (await h.fetch(path)).text();
      expect(raw).not.toContain("PRIVATE KEY");
      expect(raw).not.toContain("enc:v1:");
    }
    // …and neither does `generate`, whose response is the only place one could
    // plausibly have leaked.
    const created = await (
      await h.fetch(BASE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    ).text();
    expect(created).not.toContain("PRIVATE KEY");
  });

  test("every state the service knows is a state the API can report", () => {
    // A status the API schema omits would be one an operator sees as an empty
    // badge with no way to act on it.
    expect([...KEY_STATUSES]).toEqual(["standby", "in_use", "previously_used", "revoked"]);
  });

  test("the MCP tools cover the life cycle, and say what order to use them in", () => {
    expect(signingKeysTools.map((t) => t.name).sort()).toEqual([
      "signing_keys.generate",
      "signing_keys.list",
      "signing_keys.promote",
      "signing_keys.restore",
      "signing_keys.revoke",
    ]);
    const generate = signingKeysTools.find((t) => t.name === "signing_keys.generate")!;
    // An agent that promoted immediately would mint tokens nobody could verify.
    expect(generate.description).toContain("standby");
    expect(generate.description).toContain("cache");
    const revoke = signingKeysTools.find((t) => t.name === "signing_keys.revoke")!;
    expect(revoke.description).toContain("Refused for the key in use");
  });

  test("the SDK points at routes that exist", async () => {
    const { makeSigningKeys } = await import("../../../packages/client/src/clients/signing-keys");
    const calls: string[] = [];
    const core = {
      request: async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        return {} as never;
      },
    } as never;
    const keys = makeSigningKeys(core);
    await keys.list();
    await keys.generate();
    await keys.import("pem");
    await keys.promote(id);
    await keys.revoke(id);
    await keys.restore(id);
    await keys.delete(id);
    expect(calls).toEqual([
      `GET ${BASE}`,
      `POST ${BASE}`,
      `POST ${BASE}/import`,
      `POST ${BASE}/${id}/promote`,
      `POST ${BASE}/${id}/revoke`,
      `POST ${BASE}/${id}/restore`,
      `DELETE ${BASE}/${id}`,
    ]);
    // Dispatched for real against the live id: a 404 would mean the route is
    // not mounted, which typechecks perfectly and fails in a terminal.
    for (const verb of ["promote", "revoke", "restore"]) {
      const res = await h.fetch(`${BASE}/${id}/${verb}`, { method: "POST" });
      expect(res.status).not.toBe(404);
    }
  });

  test("the routes are admin-only", async () => {
    const anon = (path: string, init?: RequestInit) =>
      h.app.request(
        path,
        { ...init, headers: { origin: "http://localhost:5173" } } as RequestInit,
        h.env,
      );
    expect((await anon(BASE)).status).toBeGreaterThanOrEqual(400);
    expect((await anon(BASE, { method: "POST" })).status).toBeGreaterThanOrEqual(400);
    expect(
      (await anon(`${BASE}/${id}/promote`, { method: "POST" })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  test("the JWKS is public — that is the whole point of it", async () => {
    const res = await h.app.request(
      "/.well-known/jwks.json",
      { headers: { origin: "http://localhost:5173" } } as RequestInit,
      h.env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"keys"');
    // Public halves only, ever.
    expect(body).not.toContain('"d"');
  });
});
