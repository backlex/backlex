import { defineProvider } from "../provider";

/**
 * Contentful — read entries of one content type into a collection.
 *
 * One-way, and that is the point: this exists so content already living in
 * Contentful can be brought into backlex, not so the two can be kept in step
 * forever. Anyone wanting the latter should pick one system.
 *
 * The Content Delivery API is read-only by design, so the token an admin pastes
 * here cannot write to their space even if this code tried.
 */

/** Contentful's own page cap. */
const PAGE = 100;

export const contentful = defineProvider({
  id: "contentful",
  label: "Contentful",
  category: "productivity",
  capabilities: ["source"],
  configFields: [
    { key: "spaceId", label: "Space ID", placeholder: "from Settings → General" },
    {
      key: "accessToken",
      label: "Content Delivery API token",
      placeholder: "from Settings → API keys",
      secret: true,
    },
  ],
  source: {
    settingFields: [
      { key: "contentType", label: "Content type ID", placeholder: "blogPost" },
      { key: "environment", label: "Environment (optional)", placeholder: "master" },
    ],
  async pull(ctx) {
      const spaceId = ctx.str("spaceId");
      const token = ctx.str("accessToken");
      const contentType = ctx.setting("contentType");
      if (!spaceId || !token) throw new Error("Contentful sync is missing its space or token");
      if (!contentType) throw new Error("Contentful sync is missing its content type");

      const environment = ctx.setting("environment") ?? "master";
      const url = new URL(
        `https://cdn.contentful.com/spaces/${encodeURIComponent(spaceId)}` +
          `/environments/${encodeURIComponent(environment)}/entries`,
      );
      url.searchParams.set("content_type", contentType);
      const limit = Math.min(ctx.limit, PAGE);
      url.searchParams.set("limit", String(limit));
      // Contentful pages by offset, and it comes back out of our own database,
      // so it is parsed rather than trusted.
      const skip = Math.max(0, Number.parseInt(ctx.cursor ?? "0", 10) || 0);
      url.searchParams.set("skip", String(skip));
      url.searchParams.set("order", "sys.createdAt");

      const res = await ctx.fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Contentful responded ${res.status}`);
      const body = (await res.json()) as {
        items?: { sys?: { id?: string; updatedAt?: string }; fields?: Record<string, unknown> }[];
        total?: number;
      };

      const items = body.items ?? [];
      const records = items
        .filter((e): e is { sys: { id: string }; fields?: Record<string, unknown> } =>
          typeof e.sys?.id === "string",
        )
        .map((e) => ({
          externalId: e.sys.id,
          data: {
            ...flattenFields(e.fields ?? {}),
            _updatedAt: (e as { sys: { updatedAt?: string } }).sys.updatedAt ?? null,
          },
        }));

      // A short page means the content type ran out; the next run starts over
      // and picks up edits, since the CDA has no incremental marker.
      return { records, cursor: items.length < limit ? null : String(skip + items.length) };
    },
  },
});

/**
 * Contentful fields are scalars, arrays, or `{ sys: { id } }` links.
 *
 * A link is flattened to the referenced id — that is the only part a collection
 * can hold without resolving the whole graph, and it is what a relation field
 * would want anyway. Anything else nested collapses to `null` rather than being
 * stringified: `[object Object]` in a text column looks like data and is not.
 */
const flattenFields = (fields: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || typeof v !== "object") {
      out[k] = v;
      continue;
    }
    if (Array.isArray(v)) {
      out[k] = v.map((x) => linkId(x) ?? (typeof x === "object" ? null : x)).filter((x) => x !== null);
      continue;
    }
    out[k] = linkId(v);
  }
  return out;
};

const linkId = (v: unknown): string | null => {
  if (!v || typeof v !== "object") return null;
  const id = (v as { sys?: { id?: unknown } }).sys?.id;
  return typeof id === "string" ? id : null;
};
