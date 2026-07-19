import type { Env } from "../env";
import type { SpanInput } from "./traces";

/**
 * OTLP/HTTP trace exporter (#15, the #4 follow-up). When `OTLP_ENDPOINT` is
 * set, every span that gets persisted to the local `spans` table is ALSO
 * shipped to the external OpenTelemetry collector as an OTLP/HTTP JSON
 * `ExportTraceServiceRequest`. Same non-blocking contract as `recordSpan`:
 * telemetry must never add latency to or fail the request that produced it.
 *
 * Config (standard OTel-style envs):
 *  - `OTLP_ENDPOINT` — collector base URL (e.g. `https://otel.example.com`).
 *    `/v1/traces` is appended unless the URL already ends with it.
 *  - `OTLP_HEADERS`  — optional `key=value,key2=value2` list (auth tokens etc.),
 *    the same format as `OTEL_EXPORTER_OTLP_HEADERS`.
 */

export const otlpEnabled = (env: Pick<Env, "OTLP_ENDPOINT">): boolean =>
  Boolean((env.OTLP_ENDPOINT ?? "").trim());

export const otlpTracesUrl = (endpoint: string): string => {
  const base = endpoint.trim().replace(/\/+$/, "");
  return base.endsWith("/v1/traces") ? base : `${base}/v1/traces`;
};

/** Parse `k=v,k2=v2` (OTEL_EXPORTER_OTLP_HEADERS format) into fetch headers. */
export const parseOtlpHeaders = (raw: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
};

const strAttr = (key: string, value: string) => ({ key, value: { stringValue: value } });
const intAttr = (key: string, value: number) => ({ key, value: { intValue: String(value) } });

/** Build the OTLP/HTTP JSON body for one server span. Exported for tests. */
export const buildOtlpPayload = (input: SpanInput): Record<string, unknown> => {
  const startNs = String(BigInt(Math.round(input.startedAt)) * 1_000_000n);
  const endNs = String(
    BigInt(Math.round(input.startedAt + Math.max(0, input.durationMs))) * 1_000_000n,
  );
  const attributes = [
    strAttr("http.request.method", input.method),
    strAttr("url.path", input.path),
    intAttr("http.response.status_code", input.status),
  ];
  if (input.tenantId) attributes.push(strAttr("backlex.tenant_id", input.tenantId));
  if (input.userId) attributes.push(strAttr("backlex.user_id", input.userId));
  if (input.errorCode) attributes.push(strAttr("backlex.error_code", input.errorCode));
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [strAttr("service.name", "backlex")],
        },
        scopeSpans: [
          {
            scope: { name: "backlex" },
            spans: [
              {
                traceId: input.trace.traceId,
                spanId: input.trace.spanId,
                ...(input.trace.parentSpanId
                  ? { parentSpanId: input.trace.parentSpanId }
                  : {}),
                name: input.name,
                kind: 2, // SPAN_KIND_SERVER
                startTimeUnixNano: startNs,
                endTimeUnixNano: endNs,
                attributes,
                status: input.status >= 500 ? { code: 2 } : { code: 0 }, // ERROR : UNSET
              },
            ],
          },
        ],
      },
    ],
  };
};

/**
 * Fire one span at the collector. Never throws; failures are logged once per
 * call and swallowed (a down collector must not break or slow requests).
 * `fetchImpl` is injectable for tests.
 */
export const exportSpanOtlp = async (
  env: Pick<Env, "OTLP_ENDPOINT" | "OTLP_HEADERS">,
  input: SpanInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> => {
  const endpoint = (env.OTLP_ENDPOINT ?? "").trim();
  if (!endpoint) return;
  try {
    const res = await fetchImpl(otlpTracesUrl(endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...parseOtlpHeaders(env.OTLP_HEADERS),
      },
      body: JSON.stringify(buildOtlpPayload(input)),
    });
    if (!res.ok) {
      console.error(`[otlp] collector responded ${res.status}`);
    }
  } catch (e) {
    console.error("[otlp] export failed", e);
  }
};
