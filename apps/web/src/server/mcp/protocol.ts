/**
 * Protocol-revision rules — the one place that knows which MCP revision a
 * request is speaking and what that obliges the answer to carry.
 *
 * backlex is a **dual-era server** in the sense `2026-07-28` defines it. That
 * revision deleted the `initialize` handshake and moved version, identity and
 * capabilities into per-request `_meta`; but it also keeps a twelve-month
 * deprecation window, and the clients that actually reach this endpoint today
 * (Claude Desktop, Cursor, the claude.ai connector, the CLI proxy) still open
 * with `initialize`. So both eras are served on the same path:
 *
 *  - a request that declares `2026-07-28` — in `params._meta` or in the
 *    `MCP-Protocol-Version` header — is **modern**: its answer carries
 *    `resultType`, `_meta['io.modelcontextprotocol/serverInfo']` and, on the
 *    cacheable methods, `ttlMs` + `cacheScope`; and its standard request
 *    headers are validated against the body.
 *  - anything else is **legacy** and gets exactly the response shape it got
 *    before this module existed. Extra fields are cheap for a modern client to
 *    ignore, but a legacy client's schema validator is not ours to gamble
 *    with, so nothing new leaks into the old shape.
 *
 * The era is a property of the request, not of a connection: the transport is
 * stateless in both directions and always was, which is the one place where
 * the old implementation was already ahead of the spec.
 */
import { RPC_ERR } from "./types";

/** The revision we implement and prefer. */
export const PROTOCOL_VERSION = "2026-07-28";

/** Every revision we answer, newest first — the order matters because this
 *  array is what an `UnsupportedProtocolVersionError` hands the client to pick
 *  from, and it should read a preference, not a set. */
export const SUPPORTED_PROTOCOL_VERSION_LIST = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;

export const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set(
  SUPPORTED_PROTOCOL_VERSION_LIST,
);

/** The newest revision that still has an `initialize` handshake. What
 *  `initialize` negotiates down to when the client asks for something we don't
 *  recognise: answering `PROTOCOL_VERSION` there would hand a handshake-era
 *  client a revision that deleted the handshake. */
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";

/** A request that declares no version at all is assumed to speak the oldest
 *  revision we support. The transport spec allows exactly this for servers
 *  that still serve pre-`2025-06-18` clients (which did not define the
 *  `MCP-Protocol-Version` header), and we do. */
const ASSUMED_LEGACY_VERSION = "2025-03-26";

/** The reserved `_meta` keys this revision defines. Spelled out rather than
 *  built from a prefix constant so a grep for the wire key finds the code. */
export const MCP_META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
  logLevel: "io.modelcontextprotocol/logLevel",
  /** W3C trace context, propagated through `_meta` per the OpenTelemetry
   *  conventions this revision documents. Read by the MCP route so a tool's
   *  internal sub-fetches join the caller's trace. */
  traceparent: "traceparent",
  tracestate: "tracestate",
} as const;

export const SERVER_INFO = { name: "backlex", version: "0.0.1" } as const;

/** Which revision a single request is speaking. */
export interface McpEra {
  /** The revision the request declared, or {@link ASSUMED_LEGACY_VERSION}. */
  version: string;
  /** True for `2026-07-28` and later: per-request metadata, `resultType`,
   *  cache hints, and header/body validation. */
  modern: boolean;
}

/** A protocol-level rejection: the JSON-RPC error body plus the HTTP status
 *  the transport must answer with. Both halves are load-bearing — a modern
 *  client tells a modern server from a legacy one by reading the body of a
 *  400, so the status alone is not the message. */
export interface ProtocolRejection {
  status: 400;
  code: number;
  message: string;
  data?: unknown;
}

/** The era a synthetic (non-transport) caller should be answered in. Used by
 *  `server/discover`, which only exists in the modern revision, so its result
 *  is shaped modern even when the request that reached it declared nothing. */
export const MODERN_ERA: McpEra = { version: PROTOCOL_VERSION, modern: true };

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** `params._meta` of an incoming message, when it has one. */
export const requestMeta = (body: {
  params?: unknown;
}): Record<string, unknown> | undefined => asRecord(asRecord(body.params)?._meta);

const metaString = (
  meta: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const v = meta?.[key];
  return typeof v === "string" ? v : undefined;
};

/**
 * Decide which revision a request speaks, or reject it.
 *
 * Two signals carry the version and the spec requires them to agree: the
 * `_meta` field is the body's claim and the header is what an intermediary
 * routes on. A load balancer trusting one while the server executes the other
 * is precisely the split-brain `HeaderMismatch` exists to prevent, so a
 * disagreement is refused before anything reads the method.
 */
export const resolveEra = (
  body: { params?: unknown },
  header: string | null,
): { era: McpEra } | { rejection: ProtocolRejection } => {
  const declared = metaString(requestMeta(body), MCP_META.protocolVersion);
  if (declared && header && declared !== header) {
    return {
      rejection: {
        status: 400,
        code: RPC_ERR.HEADER_MISMATCH,
        message: `Header mismatch: MCP-Protocol-Version header value '${header}' does not match body value '${declared}'`,
      },
    };
  }
  const requested = declared ?? header;
  if (requested !== null && requested !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.has(requested)) {
    return {
      rejection: {
        status: 400,
        code: RPC_ERR.UNSUPPORTED_PROTOCOL_VERSION,
        message: "Unsupported protocol version",
        data: { supported: [...SUPPORTED_PROTOCOL_VERSION_LIST], requested },
      },
    };
  }
  const version = requested ?? ASSUMED_LEGACY_VERSION;
  return { era: { version, modern: version === PROTOCOL_VERSION } };
};

const BASE64_PREFIX = "=?base64?";
const BASE64_SUFFIX = "?=";

/**
 * Undo the Base64 sentinel a client wraps a header value in when the value
 * can't ride in a header as-is (non-ASCII, control characters, padding).
 * A value that isn't wrapped is returned unchanged; a wrapped value that
 * doesn't decode is returned unchanged too, which makes the comparison
 * downstream fail — the right outcome, since the spec lists "contains invalid
 * characters" as a rejection reason of its own.
 */
export const decodeHeaderValue = (raw: string): string => {
  if (!raw.startsWith(BASE64_PREFIX) || !raw.endsWith(BASE64_SUFFIX)) return raw;
  const encoded = raw.slice(BASE64_PREFIX.length, raw.length - BASE64_SUFFIX.length);
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)),
    );
  } catch {
    return raw;
  }
};

/** Which body field the `Mcp-Name` header mirrors, per method. Methods absent
 *  from this map don't carry a name and must not be asked for one. */
const nameSource = (
  method: string,
  params: Record<string, unknown> | undefined,
): { field: string; value: string } | null => {
  if (!params) return null;
  if (method === "tools/call" || method === "prompts/get") {
    return typeof params.name === "string" ? { field: "params.name", value: params.name } : null;
  }
  if (method === "resources/read") {
    return typeof params.uri === "string" ? { field: "params.uri", value: params.uri } : null;
  }
  return null;
};

/**
 * Validate the standard request headers against the body.
 *
 * Two rules, deliberately asymmetric:
 *
 *  - a header that is **present** is validated in every era. A legacy client
 *    doesn't send these, so the only way to get here with a mismatched header
 *    is a broken proxy or a caller trying to make the router and the executor
 *    disagree — neither deserves the benefit of the doubt.
 *  - a header that is **missing** is only an error for a modern request.
 *    Requiring them of legacy clients would refuse every connector in the
 *    field today, which is the opposite of what the deprecation window is for.
 *
 * Notifications are exempt: this revision explicitly leaves header
 * requirements for notification POSTs undefined.
 */
export const validateStandardHeaders = (
  body: { method: string; params?: unknown },
  headers: { get: (name: string) => string | null },
  era: McpEra,
  isNotification: boolean,
): ProtocolRejection | null => {
  const mismatch = (message: string): ProtocolRejection => ({
    status: 400,
    code: RPC_ERR.HEADER_MISMATCH,
    message: `Header mismatch: ${message}`,
  });

  const declaredMethod = headers.get("mcp-method");
  if (declaredMethod !== null && declaredMethod !== body.method) {
    return mismatch(
      `Mcp-Method header value '${declaredMethod}' does not match body value '${body.method}'`,
    );
  }

  const source = nameSource(body.method, asRecord(body.params));
  const declaredName = headers.get("mcp-name");
  if (declaredName !== null && source) {
    const decoded = decodeHeaderValue(declaredName);
    if (decoded !== source.value) {
      return mismatch(
        `Mcp-Name header value '${decoded}' does not match body value '${source.value}'`,
      );
    }
  }

  if (!era.modern || isNotification) return null;

  if (headers.get("mcp-protocol-version") === null) {
    return mismatch("required header MCP-Protocol-Version is missing");
  }
  if (declaredMethod === null) {
    return mismatch("required header Mcp-Method is missing");
  }
  if (source && declaredName === null) {
    return mismatch(`required header Mcp-Name is missing (mirrors ${source.field})`);
  }
  return null;
};

/** Freshness hint attached to a cacheable result. */
export interface CacheHint {
  ttlMs: number;
  cacheScope: "public" | "private";
}

/**
 * The cache hints `2026-07-28` requires on the list/read results.
 *
 * `cacheScope` is a security decision, not a tuning knob. `public` says a
 * shared intermediary may keep one copy and hand it to the next caller — true
 * only for the results that are identical for everyone. Everything narrowed by
 * the caller's identity is `private`:
 *
 *  - `tools/list` is filtered by the caller's per-key and per-role allowlist,
 *  - `resources/*` are the workspace's own collections, behind the permission
 *    DSL.
 *
 * Caching either publicly would hand one tenant's catalog to the next, so the
 * two static, caller-independent surfaces (`prompts/list`, the resource
 * templates) are the only ones marked `public`.
 *
 * The TTLs are freshness hints for polling clients, sized to how fast the
 * underlying thing actually moves: the static catalogs change on deploy, the
 * per-caller views change when a role or a collection does.
 */
export const CACHE = {
  discover: { ttlMs: 3_600_000, cacheScope: "public" },
  toolsList: { ttlMs: 60_000, cacheScope: "private" },
  promptsList: { ttlMs: 3_600_000, cacheScope: "public" },
  resourceTemplates: { ttlMs: 3_600_000, cacheScope: "public" },
  resourcesList: { ttlMs: 60_000, cacheScope: "private" },
  resourceRead: { ttlMs: 30_000, cacheScope: "private" },
} as const satisfies Record<string, CacheHint>;

/**
 * Add what the modern revision requires to a result: the mandatory
 * `resultType`, the server's self-identification in `_meta`, and the cache
 * hints on the methods that take them. A legacy request's result is returned
 * untouched — see the dual-era note at the top of this file.
 *
 * `resultType` is only defaulted, never overwritten, so an `input_required`
 * interim result (MRTR) survives this on its way out.
 */
export const decorateResult = <T>(result: T, era: McpEra, cache?: CacheHint): T => {
  if (!era.modern) return result;
  const base = asRecord(result);
  if (!base) return result;
  return {
    ...base,
    resultType: base.resultType ?? "complete",
    ...(cache ?? {}),
    _meta: { ...asRecord(base._meta), [MCP_META.serverInfo]: SERVER_INFO },
  } as T;
};
