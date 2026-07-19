/**
 * OTLP/HTTP trace exporter (#15): payload shape, endpoint/header parsing, and
 * the never-throws contract when the collector is down or answers non-2xx.
 */
import { describe, expect, test } from "bun:test";
import {
  buildOtlpPayload,
  exportSpanOtlp,
  otlpEnabled,
  otlpTracesUrl,
  parseOtlpHeaders,
} from "../src/server/services/otlp";
import type { SpanInput } from "../src/server/services/traces";

const input: SpanInput = {
  trace: {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    parentSpanId: "00f067aa0ba902b7",
  },
  name: "GET /api/items/posts",
  method: "GET",
  path: "/api/items/posts",
  status: 200,
  durationMs: 42,
  startedAt: 1_700_000_000_000,
  tenantId: "t1",
  userId: "u1",
};

describe("OTLP exporter", () => {
  test("otlpEnabled / otlpTracesUrl / parseOtlpHeaders", () => {
    expect(otlpEnabled({})).toBe(false);
    expect(otlpEnabled({ OTLP_ENDPOINT: " " })).toBe(false);
    expect(otlpEnabled({ OTLP_ENDPOINT: "https://otel.example.com" })).toBe(true);
    expect(otlpTracesUrl("https://otel.example.com")).toBe("https://otel.example.com/v1/traces");
    expect(otlpTracesUrl("https://otel.example.com/")).toBe("https://otel.example.com/v1/traces");
    expect(otlpTracesUrl("https://otel.example.com/v1/traces")).toBe(
      "https://otel.example.com/v1/traces",
    );
    expect(parseOtlpHeaders("authorization=Bearer abc, x-tenant=t1")).toEqual({
      authorization: "Bearer abc",
      "x-tenant": "t1",
    });
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders("garbage")).toEqual({});
  });

  test("payload is a valid ExportTraceServiceRequest for one server span", () => {
    const p = buildOtlpPayload(input) as any;
    const span = p.resourceSpans[0].scopeSpans[0].spans[0];
    expect(p.resourceSpans[0].resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "backlex" },
    });
    expect(span.traceId).toBe(input.trace.traceId);
    expect(span.spanId).toBe(input.trace.spanId);
    expect(span.parentSpanId).toBe("00f067aa0ba902b7");
    expect(span.kind).toBe(2);
    expect(span.startTimeUnixNano).toBe("1700000000000000000");
    expect(span.endTimeUnixNano).toBe("1700000000042000000");
    expect(span.status).toEqual({ code: 0 });
    const attrs = Object.fromEntries(span.attributes.map((a: any) => [a.key, a.value]));
    expect(attrs["http.request.method"]).toEqual({ stringValue: "GET" });
    expect(attrs["http.response.status_code"]).toEqual({ intValue: "200" });
    expect(attrs["backlex.tenant_id"]).toEqual({ stringValue: "t1" });
  });

  test("a root span omits parentSpanId; a 5xx maps to status ERROR", () => {
    const p = buildOtlpPayload({
      ...input,
      trace: { ...input.trace, parentSpanId: null },
      status: 500,
      errorCode: "INTERNAL",
    }) as any;
    const span = p.resourceSpans[0].scopeSpans[0].spans[0];
    expect("parentSpanId" in span).toBe(false);
    expect(span.status).toEqual({ code: 2 });
  });

  test("export POSTs to <endpoint>/v1/traces with parsed headers", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await exportSpanOtlp(
      { OTLP_ENDPOINT: "https://otel.example.com", OTLP_HEADERS: "authorization=Bearer abc" },
      input,
      fakeFetch,
    );
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://otel.example.com/v1/traces");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe("Bearer abc");
    const body = JSON.parse(String(calls[0]!.init.body)) as any;
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("GET /api/items/posts");
  });

  test("never throws: down collector and non-2xx are swallowed; unset endpoint no-ops", async () => {
    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(
      exportSpanOtlp({ OTLP_ENDPOINT: "https://down.example.com" }, input, throwingFetch),
    ).resolves.toBeUndefined();
    const rejectingFetch = (async () =>
      new Response("nope", { status: 503 })) as typeof fetch;
    await expect(
      exportSpanOtlp({ OTLP_ENDPOINT: "https://busy.example.com" }, input, rejectingFetch),
    ).resolves.toBeUndefined();
    let called = 0;
    const countingFetch = (async () => {
      called++;
      return new Response("{}");
    }) as typeof fetch;
    await exportSpanOtlp({}, input, countingFetch);
    expect(called).toBe(0);
  });
});
