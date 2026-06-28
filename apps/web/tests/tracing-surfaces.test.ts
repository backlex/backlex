/**
 * Distributed tracing — the cross-surface gate for #4.
 *
 * Covers the W3C trace-context lib, the middleware (echoes a `traceparent`,
 * continues an inbound trace), span persistence + the admin Traces API, and the
 * SDK's `traceparent` injection. If any hop stops speaking the same header this
 * suite fails.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  deriveTraceContext,
  formatTraceparent,
  parseTraceparent,
} from "../src/server/lib/trace";
import { createClient } from "../../../packages/client/src/index";

describe("trace context lib", () => {
  test("parses a valid traceparent and rejects malformed/all-zero", () => {
    const ok = parseTraceparent(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    );
    expect(ok?.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(ok?.parentSpanId).toBe("b7ad6b7169203331");
    expect(ok?.sampled).toBe(true);
    expect(parseTraceparent("garbage")).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
    // all-zero ids are invalid per spec
    expect(
      parseTraceparent("00-" + "0".repeat(32) + "-" + "0".repeat(16) + "-01"),
    ).toBeNull();
  });

  test("derive continues an inbound trace, else starts fresh", () => {
    const inbound = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const cont = deriveTraceContext(inbound, true);
    expect(cont.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(cont.parentSpanId).toBe("b7ad6b7169203331");
    expect(cont.spanId).not.toBe("b7ad6b7169203331"); // a fresh child span
    expect(cont.spanId).toMatch(/^[0-9a-f]{16}$/);

    const fresh = deriveTraceContext(undefined, true);
    expect(fresh.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh.parentSpanId).toBeNull();

    // round-trips through the header format
    const re = parseTraceparent(formatTraceparent(fresh));
    expect(re?.traceId).toBe(fresh.traceId);
    expect(re?.parentSpanId).toBe(fresh.spanId);
  });
});

describe("SDK traceparent injection", () => {
  const captured: Record<string, string>[] = [];
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    captured.push(Object.fromEntries(new Headers(init?.headers)));
    return new Response(JSON.stringify({ data: [], limit: 10, offset: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  test("on by default, omitted when tracing:false", async () => {
    const on = createClient({ url: "https://api.test", fetch: fakeFetch });
    await on.from("posts").list();
    const h1 = captured.at(-1)!;
    expect(h1.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    const off = createClient({
      url: "https://api.test",
      fetch: fakeFetch,
      tracing: false,
    });
    await off.from("posts").list();
    expect(captured.at(-1)!.traceparent).toBeUndefined();
  });

  test("a provider continues an existing trace", async () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const c = createClient({
      url: "https://api.test",
      fetch: fakeFetch,
      tracing: () => `00-${traceId}-aaaaaaaaaaaaaaaa-01`,
    });
    await c.from("posts").list();
    const hp = parseTraceparent(captured.at(-1)!.traceparent);
    expect(hp?.traceId).toBe(traceId);
  });
});

describe("middleware + span persistence + admin API", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("every response echoes a valid traceparent", async () => {
    const res = await h.fetch("/api/collections");
    const tp = res.headers.get("traceparent");
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  test("continues an inbound trace (same traceId on the response)", async () => {
    const traceId = "11112222333344445555666677778888";
    const res = await h.fetch("/api/collections", {
      headers: { traceparent: `00-${traceId}-9999888877776666-01` },
    });
    const tp = parseTraceparent(res.headers.get("traceparent"));
    expect(tp?.traceId).toBe(traceId);
  });

  test("records spans, listable + waterfall via /api/admin/traces", async () => {
    // Make a couple of identifiable requests, then wait for the fire-and-forget
    // span writes to settle.
    await h.fetch("/api/collections");
    await h.fetch("/api/collections");

    let traces: any[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await h.fetch("/api/admin/traces?path=/api/collections");
      expect(res.status).toBe(200);
      traces = ((await res.json()) as { data: any[] }).data;
      if (traces.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(traces.length).toBeGreaterThan(0);
    const trace = traces[0];
    expect(trace.name).toContain("/api/collections");
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(trace.rootStatus).toBe(200);

    const detail = await h.fetch(`/api/admin/traces/${trace.traceId}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { traceId: string; spans: any[] };
    expect(body.traceId).toBe(trace.traceId);
    expect(body.spans.length).toBeGreaterThan(0);
    expect(body.spans[0].name).toContain("/api/collections");
  });

  test("traces are admin-only (anonymous → 401/403)", async () => {
    const anon = makeHarness();
    const res = await anon.fetch("/api/admin/traces");
    expect([401, 403]).toContain(res.status);
    anon.cleanup();
  });
});
