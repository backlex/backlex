/**
 * The SDK encodes what it puts in a URL path.
 *
 * From the `packages/client` sweep #337 asks for — the package that runs in the
 * CONSUMER's process with the CONSUMER's credentials, and which the 2026-09
 * audit never opened.
 *
 * `from(slug)` interpolated both `slug` and `id` into the path raw:
 *
 *     request("GET", `/api/items/${slug}/${id}`)
 *
 * while 125 other places in the same package call `encodeURIComponent`. The
 * ordinary way an application uses this is
 * `client.from("orders").one(req.params.id)` — so an id the SDK does not encode
 * is path control handed to whoever supplies that parameter, and the request
 * goes out with the caller's API key attached. `..` segments are normalised by
 * URL parsing before the request leaves, so `../../admin/db/tables` does not
 * reach the items route at all; it reaches a different one.
 *
 * The server still applies its own authorization, so this is not a privilege
 * escalation past the credential — it is an escalation UP TO it. A server-side
 * app holding an operator API key and passing an end-user's id to `one()` lets
 * that end user aim the key.
 *
 * The assertions read the URL the transport was handed, not the response,
 * because the defect is in what gets requested. A fake fetch is the only way to
 * see that: driving the real server would answer 404 for the traversal and look
 * like a pass.
 */
import { describe, expect, test } from "bun:test";
import { BacklexError, createClient } from "../../../packages/client/src/index";

/** Records the URL each call is made with and answers with an empty envelope. */
const recorder = () => {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input.toString());
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
};

/** What the URL resolves to once the runtime has parsed it — which is what the
 *  server actually receives, `..` segments already collapsed. */
const resolved = (raw: string) => new URL(raw, "https://api.example.test").pathname;

describe("path segments the SDK builds", () => {
  test("an id containing a traversal cannot leave the items route", () => {
    const { urls, fetchImpl } = recorder();
    const client = createClient({ url: "", fetch: fetchImpl });

    // The shape an application actually writes: an id straight off a request.
    void client.from("orders").one("../../admin/db/tables");

    expect(urls).toHaveLength(1);
    expect(
      resolved(urls[0]!),
      "A `..` in the id escaped the items route. The request would still carry " +
        "the caller's credential, so whoever supplies that parameter picks the " +
        "endpoint it is spent on.",
    ).toBe("/api/items/orders/..%2F..%2Fadmin%2Fdb%2Ftables");
  });

  test("an id cannot smuggle a query string", () => {
    const { urls, fetchImpl } = recorder();
    const client = createClient({ url: "", fetch: fetchImpl });

    void client.from("orders").one("x?limit=99999&fields=*");

    const u = new URL(urls[0]!, "https://api.example.test");
    expect({ path: u.pathname, search: u.search }).toEqual({
      path: "/api/items/orders/x%3Flimit%3D99999%26fields%3D*",
      search: "",
    });
  });

  test("a slug cannot either", () => {
    const { urls, fetchImpl } = recorder();
    const client = createClient({ url: "", fetch: fetchImpl });

    void client.from("../admin/db/tables").list();

    expect(resolved(urls[0]!)).toBe("/api/items/..%2Fadmin%2Fdb%2Ftables");
  });

  test("ordinary slugs and ids are untouched (the vacuous-pass guard)", () => {
    // Encoding everything would also pass the assertions above while breaking
    // every real call. A uuid and a plain slug must come through byte for byte.
    const { urls, fetchImpl } = recorder();
    const client = createClient({ url: "", fetch: fetchImpl });

    void client.from("orders").one("9f1c2f10-4c3a-4a4e-9a1e-0f6a2b7d8c31");
    void client.from("order_items").list();

    expect(resolved(urls[0]!)).toBe("/api/items/orders/9f1c2f10-4c3a-4a4e-9a1e-0f6a2b7d8c31");
    expect(resolved(urls[1]!)).toBe("/api/items/order_items");
  });

  test("the encoding reaches the other item verbs too, not just one", () => {
    // `one` was the first one looked at; the same interpolation is repeated
    // across the collection client, and a fix that only touched one would leave
    // the rest exactly as exposed.
    const { urls, fetchImpl } = recorder();
    const client = createClient({ url: "", fetch: fetchImpl });
    const bad = "../../admin/db/tables";

    const c = client.from("orders");
    void c.update(bad, { x: 1 });
    void c.delete(bad);
    void c.transitions(bad);
    void c.discardStaged(bad);
    void c.publish(bad);
    void c.verify(bad, "pw", "x");
    // `retire` is here on purpose: it was ALREADY calling encodeURIComponent,
    // so the sweep for unencoded interpolations skipped it — and it was
    // therefore the one per-row verb still missing the dot-segment refusal.
    void c.retire(bad);

    for (const u of urls) {
      expect(resolved(u).startsWith("/api/items/orders"), `escaped: ${resolved(u)}`).toBe(true);
    }
  });

  test("a value that has NO url is refused, not escaped into a wrong one", () => {
    // `encodeURIComponent` leaves a dot alone — it is unreserved — and a dot
    // segment is stripped by the URL parser AFTER percent-decoding, so `%2E%2E`
    // is stripped too. There is no encoding that survives, which is why these
    // three are refused instead. Without the refusal `one("..")` would quietly
    // become `GET /api/items/` — a LIST of the collection where a row read was
    // asked for.
    const { urls, fetchImpl } = recorder();
    const client = createClient({ url: "", fetch: fetchImpl });

    for (const bad of ["..", ".", ""]) {
      expect(() => client.from("orders").one(bad), `id ${JSON.stringify(bad)}`).toThrow(
        BacklexError,
      );
      expect(() => client.from(bad), `slug ${JSON.stringify(bad)}`).toThrow(BacklexError);
    }
    // Refused BEFORE the request — the credential never leaves.
    expect(urls).toEqual([]);
  });

  test("the refusal carries the shape a caller already handles", () => {
    const { fetchImpl } = recorder();
    const client = createClient({ url: "", fetch: fetchImpl });

    const err = (() => {
      try {
        client.from("orders").one("..");
      } catch (e) {
        return e as BacklexError;
      }
      return null;
    })();

    expect(err).toBeInstanceOf(BacklexError);
    expect({ code: err!.code, status: err!.status }).toEqual({ code: "VALIDATION", status: 400 });
    expect(err!.message).toContain("Item id");
  });
});
