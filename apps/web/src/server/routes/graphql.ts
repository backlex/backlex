import { AppError } from "@backlex/core";
import { createYoga } from "graphql-yoga";
import { Kind, parse, valueFromASTUntyped, type FieldNode, type OperationDefinitionNode } from "graphql";
import type { Context, Hono } from "hono";
import type { AppBindings } from "../app";
import { getRequestPermCache } from "../middleware/permission";
import { getSchema } from "../services/graphql";
import { budgetFromEnv, overBudget } from "../services/graphql/cost";
import { loadCollection } from "../services/items/collection-loader";
import { openRealtimeSubscribe } from "./realtime";

/** `{query}` / `[{query}, …]` → the query strings it carries. */
const queriesOfPayload = (body: unknown): string[] => {
  const one = (v: unknown): string[] =>
    v && typeof v === "object" && typeof (v as { query?: unknown }).query === "string"
      ? [(v as { query: string }).query]
      : [];
  return Array.isArray(body) ? body.flatMap(one) : one(body);
};

/**
 * Every GraphQL document carried by a request, for the cost guard to measure.
 *
 * Read off a **clone** so the original body is still intact for yoga; a batched
 * (array) payload contributes one entry per operation.
 *
 * This must recognise every request shape yoga itself parses, or the shape it
 * misses becomes the way around the budget: yoga accepts a GET query string,
 * JSON, a raw `application/graphql` body, form-url-encoded, and multipart with
 * an `operations` field (the file-upload spec). Reading only JSON would leave
 * four open doors. `isContentTypeMatch` in yoga does a prefix test on the
 * header, so the checks here are prefix tests too — `application/json;
 * charset=utf-8` has to match the same way it does there.
 *
 * A body that cannot be read at all yields an empty list: a malformed request
 * is yoga's to reject in the standard GraphQL error shape, not the guard's to
 * turn into a 422.
 */
const queriesOf = async (req: Request): Promise<string[]> => {
  if (req.method === "GET") {
    const q = new URL(req.url).searchParams.get("query");
    return q ? [q] : [];
  }
  if (req.method !== "POST") return [];
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  const clone = req.clone();
  try {
    if (ct.startsWith("application/graphql") && !ct.startsWith("application/graphql+json")) {
      // The body IS the document.
      return [await clone.text()];
    }
    if (ct.startsWith("application/x-www-form-urlencoded")) {
      const q = new URLSearchParams(await clone.text()).get("query");
      return q ? [q] : [];
    }
    if (ct.startsWith("multipart/form-data")) {
      const ops = (await clone.formData()).get("operations");
      return typeof ops === "string" ? queriesOfPayload(JSON.parse(ops)) : [];
    }
    return queriesOfPayload(await clone.json());
  } catch {
    return [];
  }
};

/**
 * GraphQL request handler. app.ts mounts this via a **dynamic import** so the
 * whole graphql-yoga + graphql + @graphql-tools dependency graph (a large slice
 * of the worker bundle) stays OUT of the cold-start eval path — it loads only
 * when `/api/graphql` is first hit, then the module is cached per isolate.
 */
export const handleGraphql = async (
  c: Context<AppBindings>,
  app?: Hono,
): Promise<Response> => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  if (!auth.tenantId) {
    throw new AppError("UNAUTHORIZED", "Active tenant required");
  }
  // Cost/depth/alias budget, BEFORE the schema is built and long before a row
  // is read — a document that cannot be afforded should not even pay for
  // schema generation. See services/graphql/cost.ts.
  const budget = budgetFromEnv(ctx.env);
  for (const query of await queriesOf(c.req.raw)) {
    let doc;
    try {
      doc = parse(query);
    } catch {
      continue; // yoga reports the syntax error in its own shape
    }
    const reason = overBudget(doc, budget);
    if (reason) throw new AppError("VALIDATION", reason);
  }
  const schema = await getSchema(ctx, auth.tenantId);
  const permCache = getRequestPermCache(c);
  // `app` + the raw request let the `runAgent` mutation issue identity-carrying
  // in-process sub-fetches to run an agent's MCP tools (same as the REST route).
  const yoga = createYoga({
    schema,
    graphqlEndpoint: "/api/graphql",
    context: () => ({ ctx, auth, permCache, app, rawRequest: c.req.raw }),
    landingPage: false,
    graphiql: { defaultQuery: "{ _empty }" },
  });
  // yoga returns a Response with a ReadableStream body. Returning it
  // directly through Hono on Cloudflare workers serializes the body as
  // the literal string `[object ReadableStream]`. Drain to text and
  // forward as a fresh Response so the client gets the actual payload.
  const res = await yoga.fetch(c.req.raw);
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: res.headers,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL subscriptions over SSE (graphql-sse "distinct connections" mode).
//
// `subscription { items(collection: "posts", filter: {...}) { event data } }`
// opens one SSE stream per operation. Rather than reimplementing streaming,
// the handler maps the operation onto the realtime layer's `items:<slug>`
// channel and delegates to `openRealtimeSubscribe` — so the permission gate,
// the live-query `filter` validation, AND all three transports (Workers DO
// bridge / Redis long-poll / in-process bus) are exactly the ones
// `/api/realtime` ships. The upstream SSE frames are then reframed into the
// graphql-sse protocol: `event: next` + `{ data: { items: <event> } }`
// envelopes, ids passed through for Last-Event-ID resume, heartbeats kept.
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedSubscription {
  collection: string;
  filter: unknown;
  alias: string;
  /** Top-level fields selected on the payload (empty = all). */
  selected: string[];
}

const parseSubscription = (
  query: string,
  variables: Record<string, unknown>,
): ParsedSubscription => {
  let doc;
  try {
    doc = parse(query);
  } catch (e) {
    throw new AppError("VALIDATION", `Invalid GraphQL document: ${(e as Error).message}`);
  }
  const op = doc.definitions.find(
    (d): d is OperationDefinitionNode =>
      d.kind === Kind.OPERATION_DEFINITION && d.operation === "subscription",
  );
  if (!op) {
    throw new AppError("VALIDATION", "Document must contain a subscription operation");
  }
  const fields = op.selectionSet.selections.filter(
    (s): s is FieldNode => s.kind === Kind.FIELD,
  );
  const field = fields[0];
  if (!field || fields.length !== 1 || field.name.value !== "items") {
    throw new AppError(
      "VALIDATION",
      'Subscriptions support exactly one root field: items(collection: "<slug>", filter: <json>)',
    );
  }
  let collection: unknown;
  let filter: unknown;
  for (const arg of field.arguments ?? []) {
    const value = valueFromASTUntyped(arg.value, variables);
    if (arg.name.value === "collection") collection = value;
    else if (arg.name.value === "filter") filter = value;
  }
  if (typeof collection !== "string" || collection.length === 0) {
    throw new AppError("VALIDATION", "items(collection: …) is required");
  }
  return {
    collection,
    filter,
    alias: field.alias?.value ?? "items",
    selected: (field.selectionSet?.selections ?? [])
      .filter((s): s is FieldNode => s.kind === Kind.FIELD)
      .map((s) => s.name.value),
  };
};

/** Reframe one upstream realtime SSE frame into graphql-sse protocol text.
 *  Returns "" to drop the frame. */
const reframe = (frame: string, sub: ParsedSubscription): string => {
  if (frame.startsWith(":")) return `${frame}\n\n`; // heartbeat comment
  let event = "message";
  let id: string | undefined;
  let retry: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("retry:")) retry = line.slice(6).trim();
  }
  if (event === "ready") {
    // Not part of graphql-sse — surface as a comment (+ keep the retry hint).
    return `${retry ? `retry: ${retry}\n` : ""}: ready\n\n`;
  }
  if (event !== "message" || dataLines.length === 0) return "";
  let payload: unknown;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch {
    return "";
  }
  if (
    sub.selected.length > 0 &&
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
  ) {
    const projected: Record<string, unknown> = {};
    for (const k of sub.selected) {
      if (k in (payload as Record<string, unknown>)) {
        projected[k] = (payload as Record<string, unknown>)[k];
      }
    }
    payload = projected;
  }
  const envelope = JSON.stringify({ data: { [sub.alias]: payload } });
  return `event: next\n${id ? `id: ${id}\n` : ""}data: ${envelope}\n\n`;
};

/**
 * GraphQL-subscription endpoint (`/api/graphql/stream`). Accepts the operation
 * as POST JSON (`{ query, variables }`) or GET `?query=…&variables=…` — both
 * shapes the graphql-sse client emits in distinct-connections mode.
 */
export const handleGraphqlStream = async (
  c: Context<AppBindings>,
): Promise<Response> => {
  const auth = c.get("auth");
  if (!auth.tenantId) {
    throw new AppError("UNAUTHORIZED", "Active tenant required");
  }
  let query: string | undefined;
  let variables: Record<string, unknown> = {};
  if (c.req.method === "POST") {
    const body = (await c.req.json().catch(() => ({}))) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    query = body.query;
    variables = body.variables ?? {};
  } else {
    query = c.req.query("query");
    const rawVars = c.req.query("variables");
    if (rawVars) {
      try {
        variables = JSON.parse(rawVars) as Record<string, unknown>;
      } catch {
        throw new AppError("VALIDATION", "variables must be JSON");
      }
    }
  }
  if (!query) throw new AppError("VALIDATION", "query is required");
  const sub = parseSubscription(query, variables);

  // Friendlier than the realtime channel's admin behavior (silent empty
  // stream): a subscription on a collection that doesn't exist is a 404.
  const collection = await loadCollection(c.get("ctx"), auth.tenantId, sub.collection).catch(
    () => null,
  );
  if (!collection) {
    throw new AppError("NOT_FOUND", `Collection "${sub.collection}" not found`);
  }

  const upstream = await openRealtimeSubscribe(
    c,
    `items:${sub.collection}`,
    sub.filter === undefined ? undefined : JSON.stringify(sub.filter),
  );
  if (!upstream.body) return upstream;

  // Reframe the realtime SSE stream into graphql-sse frames on the fly.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const out = reframe(frame, sub);
        if (out) controller.enqueue(encoder.encode(out));
        idx = buffer.indexOf("\n\n");
      }
    },
    flush(controller) {
      // graphql-sse: tell the client the operation is over (it may reconnect
      // with Last-Event-ID to resume — the serverless long-poll path closes
      // after each delivered batch by design).
      controller.enqueue(encoder.encode("event: complete\ndata:\n\n"));
    },
  });

  const headers = new Headers(upstream.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  headers.set("X-Accel-Buffering", "no");
  return new Response(upstream.body.pipeThrough(transform), {
    status: upstream.status,
    headers,
  });
};
