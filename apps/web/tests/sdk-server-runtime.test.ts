/**
 * The three things that made the SDK unusable from a server runtime.
 *
 * Found by building a Next.js customer portal against the published client:
 * every `auth.*` call 403'd, every auth failure arrived as `UNKNOWN`, and
 * `subscribe()` threw `ReferenceError: EventSource is not defined`. The portal
 * had to hand-write all three workarounds. These pin the fixes.
 */
import { describe, expect, test } from "bun:test";
import { BacklexError, createClient } from "../../../packages/client/src/index";

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("BacklexError reads both error shapes", () => {
  test("backlex's own envelope", () => {
    const e = new BacklexError(422, {
      error: { code: "VALIDATION", message: 'Field "title" is required', details: { field: "title" } },
    });
    expect(e.code).toBe("VALIDATION");
    expect(e.message).toBe('Field "title" is required');
    expect(e.details).toEqual({ field: "title" });
  });

  test("better-auth's FLAT shape — the one a sign-in form has to render", () => {
    // Verbatim from POST /api/t/<slug>/auth/sign-in/email with a bad password.
    const e = new BacklexError(401, {
      message: "Invalid email or password",
      code: "INVALID_EMAIL_OR_PASSWORD",
    });
    expect(e.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(e.message).toBe("Invalid email or password");
  });

  test("an envelope beats a flat body when a response carries both", () => {
    const e = new BacklexError(400, {
      error: { code: "OUTER", message: "outer" },
      message: "inner",
      code: "INNER",
    });
    expect(e.code).toBe("OUTER");
    expect(e.message).toBe("outer");
  });

  test("an empty body still yields a usable error", () => {
    const e = new BacklexError(502, undefined);
    expect(e.status).toBe(502);
    expect(e.code).toBe("UNKNOWN");
    expect(e.message).toBe("HTTP 502");
  });
});

describe("Origin is sent off-browser", () => {
  const capture = () => {
    const seen: Record<string, string>[] = [];
    const fetchMock = (async (_url: string, init: RequestInit) => {
      seen.push((init.headers ?? {}) as Record<string, string>);
      return jsonRes(200, { data: [] });
    }) as unknown as typeof fetch;
    return { seen, fetchMock };
  };

  /**
   * This suite preloads happy-dom process-wide, so `window` is defined even in
   * specs that have nothing to do with the DOM — and the client reads exactly
   * that to decide whether it is in a browser. Without this, "off-browser"
   * tests silently exercise the browser path and pass for the wrong reason.
   */
  const asServerRuntime = async <T>(body: () => Promise<T>): Promise<T> => {
    const g = globalThis as { window?: unknown };
    const had = "window" in g;
    const prev = g.window;
    delete g.window;
    try {
      return await body();
    } finally {
      if (had) g.window = prev;
    }
  };

  test("defaults to the API's own origin — without it better-auth 403s every server call", async () => {
    const { seen, fetchMock } = capture();
    await asServerRuntime(async () => {
      await createClient({ url: "https://api.test", fetch: fetchMock }).from("posts").list();
    });
    expect(seen[0]?.origin).toBe("https://api.test");
  });

  test("an explicit origin wins, for a trusted-origin list that names the app host", async () => {
    const { seen, fetchMock } = capture();
    await asServerRuntime(async () => {
      await createClient({ url: "https://api.test", origin: "https://app.test", fetch: fetchMock })
        .from("posts")
        .list();
    });
    expect(seen[0]?.origin).toBe("https://app.test");
  });

  test("a relative url has no origin to derive, and none is invented", async () => {
    const { seen, fetchMock } = capture();
    await asServerRuntime(async () => {
      await createClient({ url: "", fetch: fetchMock }).from("posts").list();
    });
    expect(seen[0]?.origin).toBeUndefined();
  });

  test("never sent from a browser — there the browser is the authority", async () => {
    const { seen, fetchMock } = capture();
    const g = globalThis as { window?: unknown };
    const had = "window" in g;
    const prev = g.window;
    g.window = { document: {} };
    try {
      await createClient({ url: "https://api.test", fetch: fetchMock }).from("posts").list();
      expect(seen[0]?.origin).toBeUndefined();
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
  });
});

describe("subscribe() reads SSE over fetch, not EventSource", () => {
  /** A body that emits pre-baked SSE frames, then stays open. */
  const sseBody = (frames: string[]) =>
    new ReadableStream<Uint8Array>({
      start(ctrl) {
        const enc = new TextEncoder();
        for (const f of frames) ctrl.enqueue(enc.encode(f));
        ctrl.close();
      },
    });

  test("authenticates with a bearer token and emits only `message` frames", async () => {
    let headers: Record<string, string> = {};
    const fetchMock = (async (_url: string, init: RequestInit) => {
      headers = (init.headers ?? {}) as Record<string, string>;
      return new Response(
        sseBody([
          // The stream opens with `ready`, which must NOT surface as an item
          // event. Its payload is deliberately VALID JSON: with the channel
          // name the server really sends, a filter regression would be masked
          // by the JSON.parse failing anyway, and the test would pass for the
          // wrong reason.
          'event: ready\ndata: {"event":"ready","data":{"id":"0"}}\nretry: 3000\n\n',
          'event: message\ndata: {"event":"created","data":{"id":"1"}}\nid: 7\n\n',
          // CRLF framing and a comment keep-alive are both legal.
          ': keep-alive\r\n\r\nevent: message\r\ndata: {"event":"updated","data":{"id":"1"}}\r\nid: 8\r\n\r\n',
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const seen: string[] = [];
    const c = createClient({ url: "https://api.test", apiKey: "pak_test", fetch: fetchMock });
    const off = c.subscribe("presence:room", (e) => seen.push(e.event));
    await new Promise((r) => setTimeout(r, 60));
    off();

    // EventSource could not have sent this, which is the whole point.
    expect(headers.authorization).toBe("Bearer pak_test");
    expect(headers.accept).toBe("text/event-stream");
    expect(seen).toEqual(["created", "updated"]);
  });

  test("a multi-line data payload is joined, not truncated at the first line", async () => {
    const fetchMock = (async () =>
      new Response(sseBody(['event: message\ndata: {"event":"created",\ndata: "data":{"id":"1"}}\n\n']), {
        status: 200,
      })) as unknown as typeof fetch;
    const seen: unknown[] = [];
    const c = createClient({ url: "https://api.test", fetch: fetchMock });
    const off = c.subscribe("presence:room", (e) => seen.push(e.data));
    await new Promise((r) => setTimeout(r, 60));
    off();
    expect(seen).toEqual([{ id: "1" }]);
  });

  test("a non-2xx surfaces through onError instead of hanging silently", async () => {
    const fetchMock = (async () =>
      jsonRes(403, { error: { code: "FORBIDDEN", message: "No permission to read" } })) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const c = createClient({ url: "https://api.test", fetch: fetchMock });
    const off = c.subscribe("presence:room", () => {}, (e) => errors.push(e));
    await new Promise((r) => setTimeout(r, 60));
    off();
    expect(errors).toHaveLength(1);
    expect((errors[0] as BacklexError).code).toBe("FORBIDDEN");
  });

  test("unsubscribing aborts the request rather than reporting it as a failure", async () => {
    let aborted = false;
    const fetchMock = (async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      // Never closes on its own — only the unsubscribe can end it.
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const c = createClient({ url: "https://api.test", fetch: fetchMock });
    const off = c.subscribe("presence:room", () => {}, (e) => errors.push(e));
    await new Promise((r) => setTimeout(r, 40));
    off();
    await new Promise((r) => setTimeout(r, 40));
    expect(aborted).toBe(true);
    expect(errors).toEqual([]);
  });
});
