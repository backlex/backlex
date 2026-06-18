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
 * MCP allowlist also gates `resources/list` (an agent doesn't see resources
 * it could never read).
 */
import type { ToolCtx } from "./types";
import { readJson } from "./internal-fetch";

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
  | { kind: "collection"; slug: string };

const parseUri = (uri: string): ParsedUri | null => {
  if (uri === SCHEMA_URI) return { kind: "schema" };
  if (uri === OPENAPI_URI) return { kind: "openapi" };
  if (uri === ROLES_URI) return { kind: "roles" };
  const m = uri.match(/^backlex:\/\/collection\/([a-z][a-z0-9_-]*)$/i);
  if (!m) return null;
  return { kind: "collection", slug: m[1]! };
};

/** Build the `resources/list` response — every collection the active caller
 *  can read, plus the workspace-level schema directory. Empty (just schema)
 *  for tenants with no collections yet. */
export const listResources = async (ctx: ToolCtx): Promise<{ resources: McpResource[] }> => {
  const res = await ctx.fetchInternal(`/api/collections`);
  const body = await readJson<{ data: CollectionMeta[] }>(res);
  const resources: McpResource[] = body.data.map((c) => ({
    uri: collectionUri(c.slug),
    name: c.plural ?? c.singular ?? c.slug,
    description:
      c.note ??
      `Collection "${c.slug}" — ${Array.isArray(c.fields) ? c.fields.length : 0} fields.`,
    mimeType: "application/json",
  }));
  resources.unshift(
    {
      uri: SCHEMA_URI,
      name: "Workspace schema",
      description: "Every collection in the workspace — slug + field list.",
      mimeType: "application/json",
    },
    {
      uri: OPENAPI_URI,
      name: "REST API (OpenAPI)",
      description: "The workspace's full OpenAPI 3.1 spec — every endpoint, params, and schema.",
      mimeType: "application/json",
    },
  );
  // Roles + their permission rules are admin-only upstream (`/api/roles`), so
  // only surface the resource on the admin mount; a tenant caller wouldn't be
  // able to read it anyway.
  if (ctx.mode === "admin") {
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

/** Read a resource. Per spec the response is a `contents` array; we always
 *  return one entry so MCP clients render it as a single attachment. */
export const readResource = async (
  ctx: ToolCtx,
  uri: string,
): Promise<McpResourceContents> => {
  const parsed = parseUri(uri);
  if (!parsed) {
    throw new Error(`unknown resource uri: ${uri}`);
  }

  if (parsed.kind === "openapi") {
    return passthroughJson(ctx, uri, `/api/openapi.json`);
  }

  if (parsed.kind === "roles") {
    return passthroughJson(ctx, uri, `/api/roles`);
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
