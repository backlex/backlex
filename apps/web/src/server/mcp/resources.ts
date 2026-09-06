/**
 * MCP resources surface. Two URI shapes exposed:
 *
 *   - `backlex://collection/<slug>` — per-collection resource. `read` returns
 *     the full field schema + the first N rows of the collection's data, so
 *     a client can `📎 attach` a collection into an AI conversation without
 *     having to compose a tool call.
 *   - `backlex://schema` — workspace-level resource. `read` returns every
 *     collection's slug + field names (an at-a-glance directory).
 *
 * Resources go through the same `fetchInternal` sub-fetch the tools use, so
 * permissions, DSL filters, and tenant isolation are reused verbatim. A key's
 * MCP allowlist also gates `resources/list` AND `resources/read` (an agent
 * doesn't see, or get, a resource it could never read through a tool).
 *
 * That second sentence used to be here and was not true: the allowlist was
 * applied to `tools/*` and nowhere else, so a key narrowed to one tool still
 * read every collection's schema and a sample of its rows through this channel.
 * See {@link RESOURCE_REQUIRES}.
 */
import { AppError } from "@backlex/core";
import type { ToolCtx } from "./types";
import { readJson } from "./internal-fetch";
import { isToolAllowed, type KeyGuards } from "./guards";

const SAMPLE_ROWS = 5;

interface CollectionMeta {
  slug: string;
  singular?: string | null;
  plural?: string | null;
  note?: string | null;
  fields: Array<{ name: string; type: string }>;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

export interface McpResourceContents {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

const collectionUri = (slug: string): string => `backlex://collection/${slug}`;

const SCHEMA_URI = "backlex://schema";
const OPENAPI_URI = "backlex://openapi";
const ROLES_URI = "backlex://roles";
const ME_URI = "backlex://me";

/** Parameterised resource shape advertised at `resources/templates/list`, so a
 *  template-aware client offers "open collection …" with the slug as a fill-in
 *  (and its `slug` argument is completable — see completions.ts). */
export const RESOURCE_TEMPLATES: McpResourceTemplate[] = [
  {
    uriTemplate: "backlex://collection/{slug}",
    name: "Collection",
    description: "A collection's field schema + a sample of its rows. Fill in the collection slug.",
    mimeType: "application/json",
  },
];

export const listResourceTemplates = (): { resourceTemplates: McpResourceTemplate[] } => ({
  resourceTemplates: RESOURCE_TEMPLATES,
});

/** The caller's readable collection slugs — backs both `resources/list` and the
 *  `collection` / `slug` argument completions. Permission DSL applies via the
 *  sub-fetch, so an agent only completes collections it can actually read. */
export const listCollectionSlugs = async (ctx: ToolCtx): Promise<string[]> => {
  const res = await ctx.fetchInternal(`/api/collections`);
  const body = await readJson<{ data: CollectionMeta[] }>(res);
  return body.data.map((c) => c.slug);
};

type ParsedUri =
  | { kind: "schema" }
  | { kind: "openapi" }
  | { kind: "roles" }
  | { kind: "me" }
  | { kind: "collection"; slug: string };

const parseUri = (uri: string): ParsedUri | null => {
  if (uri === SCHEMA_URI) return { kind: "schema" };
  if (uri === OPENAPI_URI) return { kind: "openapi" };
  if (uri === ROLES_URI) return { kind: "roles" };
  if (uri === ME_URI) return { kind: "me" };
  const m = uri.match(/^backlex:\/\/collection\/([a-z][a-z0-9_-]*)$/i);
  if (!m) return null;
  return { kind: "collection", slug: m[1]! };
};

/**
 * The tool each resource stands in for, so a narrowed key cannot read through
 * the resource channel what its allowlist refuses through `tools/call`.
 *
 * The allowlist was applied to `tools/*` and to nothing else. Reproduced: a key
 * minted with `mcpTools: ["storage.list"]` got exactly one tool from
 * `tools/list`, was refused `collections.list` with the allowlist message — and
 * then `resources/read backlex://collection/secrets` handed back that
 * collection's fields AND a sample row. `backlex://openapi` likewise returned
 * the workspace's whole endpoint surface.
 *
 * It is not privilege escalation past the credential's own reach — the rows are
 * still clamped by the identity's permission DSL — but the allowlist is
 * documented as what narrows an agent, and `db.execute_sql`'s own description
 * tells operators to "pair with the per-key MCP allowlist". A control that is
 * documented and half-applied is worse than one that is absent, because it is
 * the one people rely on.
 *
 * `backlex://me` is deliberately ungated: it reports the caller's OWN identity
 * and its active guards, which is most useful precisely to a key that has been
 * narrowed and needs to say why it cannot do something.
 */
const RESOURCE_REQUIRES: Record<string, readonly string[]> = {
  schema: ["schema.list_collections"],
  // The per-collection resource returns metadata AND a sample of rows, so it
  // needs both the describe tool and the one that reads rows.
  collection: ["schema.describe_collection", "collections.list"],
  openapi: ["schema.list_collections"],
  roles: ["roles.list"],
};

/** Is this resource kind readable under the caller's active guards? */
const resourceAllowed = (kind: string, guards: KeyGuards): boolean => {
  const required = RESOURCE_REQUIRES[kind];
  if (!required) return true; // `me`, and anything new that carries no data
  return required.every((tool) => isToolAllowed(tool, guards));
};

/** Build the `resources/list` response — every collection the active caller
 *  can read, plus the workspace-level schema directory. Empty (just schema)
 *  for tenants with no collections yet. */
export const listResources = async (ctx: ToolCtx): Promise<{ resources: McpResource[] }> => {
  // Hidden as well as refused. Advertising a resource the caller cannot read
  // tells it the collection exists and makes every agent discover the limit by
  // hitting it.
  const allowed = (kind: string) => resourceAllowed(kind, ctx.guards);
  const res = await ctx.fetchInternal(`/api/collections`);
  const body = await readJson<{ data: CollectionMeta[] }>(res);
  const resources: McpResource[] = (allowed("collection") ? body.data : []).map((c) => ({
    uri: collectionUri(c.slug),
    name: c.plural ?? c.singular ?? c.slug,
    description:
      c.note ??
      `Collection "${c.slug}" — ${Array.isArray(c.fields) ? c.fields.length : 0} fields.`,
    mimeType: "application/json",
  }));
  resources.unshift(
    ...(allowed("schema")
      ? [
          {
            uri: SCHEMA_URI,
            name: "Workspace schema",
            description: "Every collection in the workspace — slug + field list.",
            mimeType: "application/json",
          },
        ]
      : []),
    ...(allowed("openapi")
      ? [
          {
            uri: OPENAPI_URI,
            name: "REST API (OpenAPI)",
            description:
              "The workspace's full OpenAPI 3.1 spec — every endpoint, params, and schema.",
            mimeType: "application/json",
          },
        ]
      : []),
    {
      uri: ME_URI,
      name: "Who am I",
      description: "The current caller's identity, roles, tenant, and active MCP guards (read-only / allowlist).",
      mimeType: "application/json",
    },
  );
  // Roles + their permission rules are admin-only upstream (`/api/roles`), so
  // only surface the resource on the admin mount; a tenant caller wouldn't be
  // able to read it anyway.
  if (ctx.mode === "admin" && allowed("roles")) {
    resources.push({
      uri: ROLES_URI,
      name: "Roles & permissions",
      description: "Every role and its permission rules (collection, action, condition, fields).",
      mimeType: "application/json",
    });
  }
  return { resources };
};

/** Pass an upstream JSON endpoint's body straight through as a resource. */
const passthroughJson = async (
  ctx: ToolCtx,
  uri: string,
  path: string,
): Promise<McpResourceContents> => {
  const res = await ctx.fetchInternal(path);
  const body = await readJson<unknown>(res);
  return {
    contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) }],
  };
};

/** A `resources/read` for a URI this server does not host. Its own class so
 *  the dispatcher can answer `-32602` (invalid params) instead of a generic
 *  internal error — the distinction matters to a client deciding whether a
 *  retry could ever help. */
export class UnknownResourceError extends Error {}

/** Read a resource. Per spec the response is a `contents` array; we always
 *  return one entry so MCP clients render it as a single attachment. */
export const readResource = async (
  ctx: ToolCtx,
  uri: string,
): Promise<McpResourceContents> => {
  const parsed = parseUri(uri);
  if (!parsed) {
    throw new UnknownResourceError(`unknown resource uri: ${uri}`);
  }
  // The same allowlist `tools/call` enforces — see `RESOURCE_REQUIRES`.
  if (!resourceAllowed(parsed.kind, ctx.guards)) {
    throw new AppError(
      "FORBIDDEN",
      `resource "${uri}" needs ${RESOURCE_REQUIRES[parsed.kind]!.join(" + ")}, ` +
        "which this API key's MCP allowlist does not grant",
    );
  }

  if (parsed.kind === "openapi") {
    return passthroughJson(ctx, uri, `/api/openapi.json`);
  }

  if (parsed.kind === "roles") {
    return passthroughJson(ctx, uri, `/api/roles`);
  }

  if (parsed.kind === "me") {
    // Identity + roles + tenant from /api/me, enriched with the caller's own
    // MCP scope (read-only? allowlist?) so an agent can reason about its limits.
    const res = await ctx.fetchInternal(`/api/me`);
    const body = await readJson<{ data: Record<string, unknown> }>(res);
    const me = {
      ...body.data,
      mcp: {
        readOnly: ctx.guards.readOnly,
        allowlist: ctx.guards.allowlist,
        // Reported separately from the key's own list: an agent that hits a
        // FORBIDDEN needs to know whether the limit travels with the key or
        // with the identity, because only one of those it can ask to change.
        roleAllowlist: ctx.guards.roleAllowlist ?? null,
      },
    };
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(me, null, 2) }],
    };
  }

  if (parsed.kind === "schema") {
    const res = await ctx.fetchInternal(`/api/collections`);
    const body = await readJson<{ data: CollectionMeta[] }>(res);
    const directory = body.data.map((c) => ({
      slug: c.slug,
      singular: c.singular ?? null,
      plural: c.plural ?? null,
      note: c.note ?? null,
      fields: (c.fields ?? []).map((f) => ({ name: f.name, type: f.type })),
    }));
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ collections: directory }, null, 2),
        },
      ],
    };
  }

  // Collection read: schema + first SAMPLE_ROWS rows. Two sub-fetches; the
  // sample is purely informational so we tolerate a failure there and still
  // return the schema portion (helps the agent describe an empty/restricted
  // collection without seeing zero data as a fatal error).
  const slug = parsed.slug;
  const metaRes = await ctx.fetchInternal(`/api/collections/${encodeURIComponent(slug)}`);
  const meta = await readJson<{ data: CollectionMeta }>(metaRes);
  let sample: unknown = null;
  let sampleError: string | null = null;
  try {
    const sampleRes = await ctx.fetchInternal(
      `/api/items/${encodeURIComponent(slug)}?limit=${SAMPLE_ROWS}`,
    );
    const sampleBody = await readJson<{ data: unknown[] }>(sampleRes);
    sample = sampleBody.data;
  } catch (e) {
    sampleError = e instanceof Error ? e.message : String(e);
  }
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            slug: meta.data.slug,
            singular: meta.data.singular ?? null,
            plural: meta.data.plural ?? null,
            note: meta.data.note ?? null,
            fields: meta.data.fields,
            sample,
            sampleError,
            sampleLimit: SAMPLE_ROWS,
          },
          null,
          2,
        ),
      },
    ],
  };
};
