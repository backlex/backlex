/**
 * Multi-surface parity for the OAuth client registry.
 *
 * Two invariants, both security claims rather than conveniences:
 *
 *  - The client secret is returned ONCE, on registration, and only for a
 *    CONFIDENTIAL client. A public client gets none, because PKCE is what
 *    protects it and a secret shipped in a browser or a CLI is not a secret.
 *    So `list()` must never carry one, on any surface.
 *  - Revoking a grant deletes the consent AND every token issued under it.
 *    Removing only the consent would be a revocation that does not revoke:
 *    the access token keeps working until it expires and the refresh token
 *    keeps minting more.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { oauthTools } from "../src/server/mcp/tools/oauth";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const BASE = "/api/admin/oauth-clients";

describe("oauth clients — surfaces", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;
  let confidentialId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });

  afterAll(() => h.close?.());

  test("SDK: a confidential client gets its secret exactly once", async () => {
    const created = await client.oauth.register({
      name: "parity-confidential",
      redirectUrls: ["https://app.test/callback"],
      type: "confidential",
    });
    expect(typeof created.clientSecret).toBe("string");
    expect(created.clientSecret!.length).toBeGreaterThan(16);
    confidentialId = created.data.clientId;

    // The one place it is ever returned. A list that carried it would put a
    // live credential into every admin screen and every log of one.
    const listed = await client.oauth.list();
    expect(JSON.stringify(listed)).not.toContain(created.clientSecret!);
  });

  test("SDK: a public client is given no secret at all", async () => {
    const created = await client.oauth.register({
      name: "parity-public",
      redirectUrls: ["https://spa.test/callback"],
      type: "public",
    });
    // Not an empty string, not a placeholder — null, so a caller that stores
    // it cannot mistake a falsy secret for a real one.
    expect(created.clientSecret).toBeNull();
  });

  test("REST: the raw surface agrees with the SDK about the secret", async () => {
    const res = await h.fetch(BASE, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "parity-rest",
        redirectUrls: ["https://rest.test/callback"],
        type: "public",
      }),
    });
    expect(res.status).toBeLessThan(300);
    const body = (await res.json()) as { clientSecret: string | null };
    expect(body.clientSecret).toBeNull();
  });

  test("MCP: the five tools an agent gets, and registration is one of them", () => {
    expect(oauthTools.map((t) => t.name).sort()).toEqual([
      "oauth.clients",
      "oauth.grants",
      "oauth.register",
      "oauth.revoke_grant",
      "oauth.set_disabled",
    ]);
  });

  test("the SDK points at routes that exist", async () => {
    const calls: string[] = [];
    const spy = {
      request: async (m: string, p: string) => {
        calls.push(`${m} ${p}`);
        return { data: [] };
      },
    };
    const { makeOAuthClients } = await import(
      "../../../packages/client/src/clients/oauth-clients"
    );
    const oauth = makeOAuthClients(spy as never);
    await oauth.list();
    await oauth.setDisabled(confidentialId, true);
    await oauth.grants({ clientId: confidentialId });
    await oauth.revokeGrant(confidentialId, "user-1");
    await oauth.delete(confidentialId);
    expect(calls).toEqual([
      `GET ${BASE}`,
      `PATCH ${BASE}/${confidentialId}`,
      `GET ${BASE}/grants?clientId=${confidentialId}`,
      `POST ${BASE}/grants/revoke`,
      `DELETE ${BASE}/${confidentialId}`,
    ]);

    // Dispatched for real against the LIVE client id, so a 404 means the
    // route is not mounted rather than "that row does not exist".
    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      const res = await h.fetch(path, {
        method,
        headers: JSON_HEADERS,
        ...(method === "PATCH"
          ? { body: JSON.stringify({ disabled: true }) }
          : method === "POST"
            ? { body: JSON.stringify({ clientId: confidentialId, userId: "user-1" }) }
            : {}),
      });
      // Asserts the STATUS, and keeps `call` in the failure output so a real
      // miss still names the route. It used to substring-match the rendered
      // line for "404" — which a UUID like `…-4047-…` satisfies on its own, so
      // every one of these files failed a few runs in a hundred for no reason.
      expect({ call, status: res.status }).not.toMatchObject({ status: 404 });
    }
  });

  test("disabling keeps the client and its history; deleting does not", async () => {
    const created = await client.oauth.register({
      name: "parity-lifecycle",
      redirectUrls: ["https://lifecycle.test/callback"],
      type: "public",
    });
    const id = created.data.clientId;

    expect((await client.oauth.setDisabled(id, true)).ok).toBe(true);
    const afterDisable = await client.oauth.list();
    // Still there — disabling is a state change, which is why the docs
    // recommend it over deletion.
    expect(afterDisable.data.some((c) => c.clientId === id)).toBe(true);

    expect((await client.oauth.delete(id)).ok).toBe(true);
    const afterDelete = await client.oauth.list();
    expect(afterDelete.data.some((c) => c.clientId === id)).toBe(false);
  });
});
