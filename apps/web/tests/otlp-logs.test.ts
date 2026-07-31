/**
 * OTLP log export.
 *
 * Two things decide whether this is useful rather than merely present:
 *
 *   - every request's lines ship, not just the sampled ones. Logs and traces
 *     have different sampling stories, and gating logs on the trace sample rate
 *     silently loses most of them.
 *   - `traceId` lands on the RECORD, not in the attribute bag, because that is
 *     where a collector looks to join a log line to its span.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildOtlpLogsPayload,
  flushLogsOtlp,
  otlpLogsUrl,
} from "../src/server/services/otlp-logs";
import { configureLogBuffer, configureLogLevel, drainLogBuffer, log } from "../src/server/lib/log";

const ENV = { OTLP_ENDPOINT: "https://otel.example.test", OTLP_HEADERS: "x-api-key=k" };

const spy = (respond: () => Response = () => new Response("", { status: 200 })) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return Object.assign(fn, { calls });
};

beforeEach(() => {
  // The logger is isolate-global and every other spec's harness sets the level
  // to `error` to keep test output quiet. Without claiming it here these tests
  // pass alone and fail in the full run, which is the worst way to find out.
  configureLogLevel("info");
  configureLogBuffer(true);
  drainLogBuffer();
});
afterEach(() => {
  configureLogBuffer(false);
  configureLogLevel("error");
});

describe("the endpoint", () => {
  test("/v1/logs is appended, and not twice", () => {
    expect(otlpLogsUrl("https://otel.example.test")).toBe("https://otel.example.test/v1/logs");
    expect(otlpLogsUrl("https://otel.example.test/")).toBe("https://otel.example.test/v1/logs");
    expect(otlpLogsUrl("https://otel.example.test/v1/logs")).toBe("https://otel.example.test/v1/logs");
  });
});

describe("buffering", () => {
  test("nothing is buffered until a collector is configured", () => {
    configureLogBuffer(false);
    log.info("ignored", { a: 1 });
    // With no consumer the buffer is a per-isolate memory cost and nothing else.
    expect(drainLogBuffer().records).toEqual([]);
  });

  test("a drain empties the buffer, so nothing ships twice", () => {
    log.info("one");
    expect(drainLogBuffer().records).toHaveLength(1);
    expect(drainLogBuffer().records).toHaveLength(0);
  });

  test("an overflowing buffer drops the OLDEST and says how many", () => {
    for (let i = 0; i < 600; i++) log.info(`line-${i}`);
    const { records, dropped } = drainLogBuffer();
    expect(records).toHaveLength(512);
    expect(dropped).toBe(88);
    // During an incident the newest lines are what is being read, so those are
    // the ones that survive.
    expect(records[records.length - 1]!.msg).toBe("line-599");
    expect(records[0]!.msg).toBe("line-88");
  });

  test("a line below the level threshold is never buffered", () => {
    log.debug("noisy probe");
    // The default threshold is `info`; buffering a line that was not even
    // printed would export more than the platform's own log drain has.
    expect(drainLogBuffer().records).toEqual([]);
  });
});

describe("the payload", () => {
  test("trace and span ids go on the record, not into the attributes", () => {
    const body = buildOtlpLogsPayload([
      {
        level: "info",
        msg: "request",
        ts: 1_700_000_000_000,
        fields: { traceId: "abc123", spanId: "def456", status: 200, path: "/api/items/posts" },
      },
    ]) as any;
    const rec = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    // Left as ordinary attributes these would render but not correlate.
    expect(rec.traceId).toBe("abc123");
    expect(rec.spanId).toBe("def456");
    const keys = rec.attributes.map((a: { key: string }) => a.key);
    expect(keys).not.toContain("traceId");
    expect(keys).toContain("status");
  });

  test("severity travels as both a number and a name", () => {
    const body = buildOtlpLogsPayload([
      { level: "error", msg: "boom", ts: 1, fields: {} },
    ]) as any;
    const rec = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    // A collector that understands only one of them still renders something.
    expect(rec.severityNumber).toBe(17);
    expect(rec.severityText).toBe("ERROR");
    expect(rec.body.stringValue).toBe("boom");
  });

  test("the timestamp is nanoseconds, as OTLP requires", () => {
    const body = buildOtlpLogsPayload([
      { level: "info", msg: "x", ts: 1_700_000_000_123, fields: {} },
    ]) as any;
    // Milliseconds here would put every line in 1970.
    expect(body.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano).toBe("1700000000123000000");
  });

  test("field types are preserved rather than flattened to strings", () => {
    const body = buildOtlpLogsPayload([
      {
        level: "info",
        msg: "x",
        ts: 1,
        fields: { count: 3, ratio: 1.5, ok: true, missing: null, nested: { a: 1 } },
      },
    ]) as any;
    const attrs = Object.fromEntries(
      body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(
        (a: { key: string; value: Record<string, unknown> }) => [a.key, a.value],
      ),
    );
    expect(attrs.count).toEqual({ intValue: "3" });
    expect(attrs.ratio).toEqual({ doubleValue: 1.5 });
    expect(attrs.ok).toEqual({ boolValue: true });
    expect(attrs.missing).toEqual({ stringValue: "" });
    // Unlike a warehouse column, an OTLP attribute is free text and the nested
    // shape is often the useful part.
    expect(attrs.nested).toEqual({ stringValue: '{"a":1}' });
  });

  test("an undefined field is omitted, not sent as empty", () => {
    const body = buildOtlpLogsPayload([
      { level: "info", msg: "x", ts: 1, fields: { present: "y", absent: undefined } },
    ]) as any;
    const keys = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(
      (a: { key: string }) => a.key,
    );
    // "no value" and "was not there" are different things.
    expect(keys).toEqual(["present"]);
  });

  test("a cyclic field costs one attribute, not the whole batch", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const body = buildOtlpLogsPayload([
      { level: "info", msg: "x", ts: 1, fields: { fine: "yes", cyclic } },
    ]) as any;
    const keys = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(
      (a: { key: string }) => a.key,
    );
    expect(keys).toEqual(["fine"]);
  });
});

describe("flushing", () => {
  test("it posts to /v1/logs with the configured headers", async () => {
    log.info("request", { status: 200 });
    const f = spy();
    await flushLogsOtlp(ENV, f);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://otel.example.test/v1/logs");
    expect((f.calls[0]!.init!.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  test("an empty buffer sends nothing", async () => {
    const f = spy();
    await flushLogsOtlp(ENV, f);
    expect(f.calls).toHaveLength(0);
  });

  test("no collector configured is a no-op that leaves the buffer alone", async () => {
    log.info("kept");
    const f = spy();
    await flushLogsOtlp({ OTLP_ENDPOINT: "", OTLP_HEADERS: undefined }, f);
    expect(f.calls).toHaveLength(0);
    // Draining here would discard lines nothing ever shipped.
    expect(drainLogBuffer().records).toHaveLength(1);
  });

  test("a dropped-lines warning is appended so the gap is not silent", async () => {
    for (let i = 0; i < 600; i++) log.info(`line-${i}`);
    const f = spy();
    await flushLogsOtlp(ENV, f);
    const body = JSON.parse(String(f.calls[0]!.init!.body)) as any;
    const records = body.resourceLogs[0].scopeLogs[0].logRecords;
    const last = records[records.length - 1];
    // A gap that nothing announces reads as "nothing happened".
    expect(last.body.stringValue).toBe("otlp log buffer overflowed");
    expect(last.severityText).toBe("WARN");
  });

  test("a collector that is down never throws into the request", async () => {
    log.info("x");
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    // Telemetry must never add latency to, or fail, the request that produced
    // it — the whole contract of this path.
    await flushLogsOtlp(ENV, failing);
  });

  test("a non-2xx collector response is reported, not retried into a loop", async () => {
    log.info("x");
    const f = spy(() => new Response("nope", { status: 503 }));
    await flushLogsOtlp(ENV, f);
    expect(f.calls).toHaveLength(1);
    // The lines are already drained; retrying here would need a queue, and a
    // queue for telemetry is how telemetry starts costing more than the app.
    expect(drainLogBuffer().records).toHaveLength(0);
  });
});

// The bug this exists to prevent: the span export sits behind a sampling gate,
// and putting the log flush inside it means that at any rate under 1 most
// requests never flush. The buffer then fills and starts dropping lines that
// were never exported anywhere.
describe("logs do not inherit the trace sample rate", () => {
  test("a request flushes its lines even when no span is sampled", async () => {
    const { makeHarness, seedAdmin } = await import("./setup");
    const posted: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      if (url.includes("/v1/logs")) {
        posted.push(String(init?.body ?? ""));
        return new Response("", { status: 200 });
      }
      if (url.includes("/v1/traces")) return new Response("", { status: 200 });
      return realFetch(input, init);
    }) as typeof fetch;

    const h = makeHarness({
      OTLP_ENDPOINT: "https://otel.example.test",
      // Nothing is sampled, so the span export block never runs.
      TRACES_SAMPLE_RATE: "0",
      // The harness defaults to `error` to keep test output quiet; the export
      // respects the threshold, so an access line needs `info` to exist at all.
      LOG_LEVEL: "info",
    });
    try {
      await seedAdmin(h);
      await h.fetch("/api/collections");
      // Give the fire-and-forget flush a turn.
      await new Promise((r) => setTimeout(r, 50));
      expect(posted.length).toBeGreaterThan(0);
      expect(posted.join(" ")).toContain("resourceLogs");
    } finally {
      globalThis.fetch = realFetch;
      h.cleanup();
      configureLogBuffer(false);
    }
  });
});
