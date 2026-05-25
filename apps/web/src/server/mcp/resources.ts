/**
 * MCP resources surface. Two URI shapes exposed:
 *
 *   - `workeros://collection/<slug>` — per-collection resource. `read` returns
 *     the full field schema + the first N rows of the collection's data, so
 *     a client can `📎 attach` a collection into an AI conversation without
 *     having to compose a tool call.
 *   - `workeros://schema` — workspace-level resource. `read` returns every
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

const collectionUri = (slug: string): string => `workeros://collection/${slug}`;

const SCHEMA_URI = "workeros://schema";

const parseUri = (uri: string): { kind: "schema" } | { kind: "collection"; slug: string } | null => {
  if (uri === SCHEMA_URI) return { kind: "schema" };
  const m = uri.match(/^workeros:\/\/collection\/([a-z][a-z0-9_-]*)$/i);
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
  resources.unshift({
    uri: SCHEMA_URI,
    name: "Workspace schema",
    description: "Every collection in the workspace — slug + field list.",
    mimeType: "application/json",
  });
  return { resources };
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
