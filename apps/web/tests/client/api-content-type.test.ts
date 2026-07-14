/**
 * Regression: the admin `api()` helper must NOT send `content-type:
 * application/json` on a bodyless request.
 *
 * publish/unpublish (and other side-effect endpoints) POST with no body. When
 * the helper still advertised `content-type: application/json`, the server's
 * zod-openapi body validator tried to parse the empty body and threw
 * "Malformed JSON in request body" → 500 before the handler ran. That's the
 * Unpublish-button 500. The header is now gated on `body` being present.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { api } from "../../src/client/lib/api";

describe("api() content-type is gated on a request body", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const runCapturing = async (path: string, init: RequestInit) => {
    let seen: RequestInit | undefined;
    global.fetch = mock(async (_url: RequestInfo | URL, reqInit?: RequestInit) => {
      seen = reqInit;
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await api(path, init);
    return new Headers(seen?.headers).get("content-type");
  };

  test("bodyless POST omits content-type", async () => {
    expect(await runCapturing("/api/items/x/y/publish?unpublish=1", { method: "POST" })).toBeNull();
  });

  test("POST with a body keeps content-type: application/json", async () => {
    expect(
      await runCapturing("/api/items/x/y/publish", {
        method: "POST",
        body: JSON.stringify({ publishAt: null }),
      }),
    ).toBe("application/json");
  });
});
