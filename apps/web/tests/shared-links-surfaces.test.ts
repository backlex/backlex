/**
 * Multi-surface parity for record share links.
 *
 * A share token is a bearer credential carried in a URL: whoever holds the
 * link reads that one record without signing in. Everything here follows from
 * that.
 *
 *  - The token is returned ONCE, on creation, and only its hash is stored. A
 *    listing that carried it would put a live credential into every screen
 *    that renders the list and every log of one.
 *  - It opens exactly the record it was minted for. If it opened a collection,
 *    one shared invoice would share the ledger.
 *  - Revoking takes effect immediately, because the alternative — a revocation
 *    that waits for an expiry — is not a revocation.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sharedLinksTools } from "../src/server/mcp/tools/shared-links";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const BASE = "/api/shared-links";

describe("shared links — surfaces", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;
  let itemId = "";
  let otherId = "";

  /**
   * A client with NO session at all.
   *
   * `h.fetch` carries the harness cookie jar, so a "visitor" built on it would
   * still be the signed-in admin, and every assertion below about a token
   * being what grants access would pass whether or not the token was checked.
   * `h.app.request` goes straight to the app and sends no cookies.
   */
  const visitorClient = () =>
    createClient({
      url: "",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        h.app.request(
          typeof input === "string" ? input : String(input),
          {
            ...init,
            headers: {
              ...((init?.headers as Record<string, string>) ?? {}),
              origin: "http://localhost:5173",
            },
          } as RequestInit,
          h.env,
        )) as typeof fetch,
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });

    await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "Invoices",
        slug: "invoices",
        fields: [{ name: "title", type: "text" }],
      }),
    });
    const mk = async (title: string) => {
      const res = await h.fetch("/api/items/invoices", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { data: { id: string } }).data.id;
    };
    itemId = await mk("Shared invoice");
    otherId = await mk("Private invoice");
  });

  afterAll(() => h.close?.());

  test("SDK: the token is returned once and never listed", async () => {
    const created = await client.sharedLinks.create({ collection: "invoices", itemId });
    expect(typeof created.data.token).toBe("string");
    expect(created.data.token.length).toBeGreaterThan(16);
    expect(created.data.url).toContain(created.data.token);

    const listed = await client.sharedLinks.list("invoices", itemId);
    expect(listed.data.some((l) => l.id === created.data.id)).toBe(true);
    // The assertion that matters: the credential is not in the listing, on any
    // field, under any name.
    expect(JSON.stringify(listed)).not.toContain(created.data.token);
  });

  test("a token opens its own record and no other", async () => {
    const created = await client.sharedLinks.create({ collection: "invoices", itemId });

    // Positive control first — without it a refusal below could just as well
    // mean the token was never valid, and the test would pass for a reason
    // that has nothing to do with scoping.
    const visitor = visitorClient();
    const opened = await visitor.sharedLinks.resolve(created.data.token);
    expect(opened.data.collection).toBe("invoices");
    expect((opened.data.item as { id: string }).id).toBe(itemId);

    // The other record exists and is NOT reachable with this token.
    const forOther = await client.sharedLinks.create({ collection: "invoices", itemId: otherId });
    const openedOther = await visitor.sharedLinks.resolve(forOther.data.token);
    expect((openedOther.data.item as { id: string }).id).toBe(otherId);
    expect((openedOther.data.item as { id: string }).id).not.toBe(itemId);
  });

  test("revoking takes effect immediately", async () => {
    const created = await client.sharedLinks.create({ collection: "invoices", itemId });
    const visitor = visitorClient();

    expect((await visitor.sharedLinks.resolve(created.data.token)).data.collection).toBe(
      "invoices",
    );

    expect((await client.sharedLinks.revoke(created.data.id)).ok).toBe(true);
    await expect(visitor.sharedLinks.resolve(created.data.token)).rejects.toBeDefined();
  });

  test("an invented token opens nothing", async () => {
    const visitor = visitorClient();
    await expect(visitor.sharedLinks.resolve("not-a-real-token")).rejects.toBeDefined();
  });

  test("MCP: the three tools an agent gets", () => {
    expect(sharedLinksTools.map((t) => t.name).sort()).toEqual([
      "shared_links.create",
      "shared_links.list",
      "shared_links.revoke",
    ]);
  });

  test("the SDK points at routes that exist", async () => {
    const live = await client.sharedLinks.create({ collection: "invoices", itemId });

    const calls: string[] = [];
    const spy = {
      request: async (m: string, p: string) => {
        calls.push(`${m} ${p}`);
        return { data: [] };
      },
    };
    const { makeSharedLinks } = await import(
      "../../../packages/client/src/clients/shared-links"
    );
    const links = makeSharedLinks(spy as never);
    await links.list("invoices", itemId);
    await links.create({ collection: "invoices", itemId });
    await links.resolve(live.data.token);
    await links.revoke(live.data.id);
    expect(calls).toEqual([
      `GET ${BASE}?collection=invoices&itemId=${itemId}`,
      `POST ${BASE}`,
      `GET /api/shared/${live.data.token}`,
      `DELETE ${BASE}/${live.data.id}`,
    ]);

    // Dispatched for real against the LIVE token and id.
    for (const call of calls) {
      const [method, path] = call.split(" ") as [string, string];
      const res = await h.fetch(path, {
        method,
        headers: JSON_HEADERS,
        ...(method === "POST"
          ? { body: JSON.stringify({ collection: "invoices", itemId }) }
          : {}),
      });
      // Asserts the STATUS, and keeps `call` in the failure output so a real
      // miss still names the route. It used to substring-match the rendered
      // line for "404" — which a UUID like `…-4047-…` satisfies on its own, so
      // every one of these files failed a few runs in a hundred for no reason.
      expect({ call, status: res.status }).not.toMatchObject({ status: 404 });
    }
  });
});
