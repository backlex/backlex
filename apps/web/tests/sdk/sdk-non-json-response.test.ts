/**
 * What the SDK does when something other than the API answers.
 *
 * The third angle #337 names, after URL construction and credentials:
 * unexpected responses. `request()` called `res.json()` on any 2xx, so a
 * 200 carrying HTML surfaced as `SyntaxError: Unexpected token '<'` — an error
 * naming neither the endpoint, nor the status, nor the fact that the body was
 * a page. The realistic way to get there is a misconfigured `url` pointing at
 * the web app instead of the API, where EVERY call comes back as the SPA's
 * index.html with a 200.
 *
 * These drive a fake fetch because the point is the SDK's reaction to a
 * response it will not otherwise see: the real server never sends one.
 */
import { describe, expect, test } from "bun:test";
import { createClient, BacklexError } from "../../../../packages/client/src";

/** A client whose transport always answers with exactly this response. */
const clientAnswering = (body: string, init: ResponseInit) =>
  createClient({
    url: "",
    fetch: (async () => new Response(body, init)) as unknown as typeof fetch,
  });

describe("a 2xx that is not JSON", () => {
  test("names the endpoint, the status and what came back instead", async () => {
    const client = clientAnswering("<!doctype html><title>My App</title><div id=root>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

    const err = await client
      .from("orders")
      .list()
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(BacklexError);
    const e = err as BacklexError;
    expect(e.code).toBe("NON_JSON_RESPONSE");
    expect(e.status).toBe(200);
    // The three things the old SyntaxError did not say.
    expect(e.message).toContain("GET /api/items/orders");
    expect(e.message).toContain("200");
    expect(e.message).toContain("text/html");
    // And a look at the body, so "which proxy answered" is answerable without
    // reaching for a network trace.
    expect((e.details as { body?: string }).body).toContain("My App");
  });

  test("the snippet is bounded — a whole page does not become the message", async () => {
    const client = clientAnswering(`<html>${"x".repeat(50_000)}</html>`, {
      status: 200,
      headers: { "content-type": "text/html" },
    });

    const e = (await client
      .from("orders")
      .list()
      .catch((x: unknown) => x)) as BacklexError;
    expect((e.details as { body: string }).body.length).toBeLessThanOrEqual(200);
  });

  test("a JSON body with a charset, or a +json media type, still parses", async () => {
    // The guard reads the media type, not the whole header, and `+json` suffix
    // types are JSON. Refusing either would break live callers rather than
    // help them — this is the vacuous-pass guard for the check above.
    for (const contentType of [
      "application/json; charset=utf-8",
      "application/problem+json",
      "application/vnd.api+json",
      "text/json",
    ]) {
      const client = clientAnswering(JSON.stringify({ data: [{ id: "1" }] }), {
        status: 200,
        headers: { "content-type": contentType },
      });
      const res = await client.from("orders").list();
      expect(res.data, contentType).toHaveLength(1);
    }
  });

  test("a response with NO content-type is still parsed", async () => {
    // Deliberate: that is what a 2xx from an endpoint which forgot the header
    // always did, and the check is not worth breaking it over.
    // Bun's `Response` sets `content-type: text/plain;charset=utf-8` for a
    // string body, so it has to be stripped to get the real no-header case.
    const stripped = createClient({
      url: "",
      fetch: (async () => {
        const r = new Response(JSON.stringify({ data: [] }), { status: 200 });
        r.headers.delete("content-type");
        return r;
      }) as unknown as typeof fetch,
    });
    expect((await stripped.from("orders").list()).data).toEqual([]);
  });

  test("a 204 is still nothing, not a parse attempt", async () => {
    const client = clientAnswering("", { status: 204 });
    await expect(client.from("orders").delete("abc")).resolves.toBeUndefined();
  });

  test("an error status keeps its API error, not the new code", async () => {
    // The non-2xx path reads the error envelope and must go on doing so — a
    // 403 with a real code must not be relabelled by the JSON guard.
    const client = clientAnswering(
      JSON.stringify({ error: { code: "FORBIDDEN", message: "nope" } }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
    const e = (await client
      .from("orders")
      .list()
      .catch((x: unknown) => x)) as BacklexError;
    expect({ code: e.code, status: e.status, message: e.message }).toEqual({
      code: "FORBIDDEN",
      status: 403,
      message: "nope",
    });
  });
});
