import { eq } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { type FieldDef, type FieldType, isPresentational } from "@backlex/db";
import type { Ctx } from "../context";

type Schema = Record<string, unknown>;

const fieldToSchema = (type: FieldType): Schema => {
  switch (type) {
    case "text":
    case "longtext":
    case "uuid":
    case "relation":
    case "file":
      return { type: "string" };
    case "integer":
      return { type: "integer", format: "int64" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "timestamp":
      return { type: "string", format: "date-time" };
    case "json":
      return {};
    case "relation_many":
      return { type: "array", items: { type: "string" } };
    case "phone":
      // Reads are always canonical E.164. Writes accept anything a human types
      // and are canonicalized server-side, which the `example` says better than
      // a pattern would — a `pattern` here would describe the READ shape and
      // make every generator reject a perfectly acceptable write.
      return { type: "string", example: "+14155552671" };
    case "email":
      // Same split as `phone`: reads are always canonical, writes accept
      // anything a person types or pastes. `format: "email"` is the standard
      // annotation and is worth emitting; a `pattern` is not, for the same
      // reason — it would describe the READ shape and make a generator reject a
      // write the server would happily fold.
      return { type: "string", format: "email", example: "ada@example.com" };
    case "money":
      // Reads are always this object. Writes accept more (a bare number, a
      // decimal string, `"19.99 USD"`, `{ minor, currency }`) — described in
      // the field's own text rather than widened here, because a schema that
      // says `oneOf` five ways is less useful to a generator than the one shape
      // it will actually receive.
      return {
        type: "object",
        properties: {
          amount: { type: "number", description: "Major units — 19.99, not 1999." },
          currency: { type: "string", description: "ISO-4217 code." },
        },
        required: ["amount", "currency"],
      };
    default:
      return {};
  }
};

const buildItemSchema = (
  slug: string,
  fields: FieldDef[],
  options: { includeId?: boolean; allFieldsOptional?: boolean } = {},
): Schema => {
  const properties: Record<string, Schema> = {};
  const required: string[] = [];

  if (options.includeId) {
    properties.id = { type: "string", description: "Stable row id." };
    properties.created_at = { type: "string", format: "date-time" };
    properties.updated_at = { type: "string", format: "date-time" };
    properties.owner_id = { type: ["string", "null"] };
  }

  for (const f of fields) {
    const base = fieldToSchema(f.type);
    const schema: Schema = { ...base };
    if (f.options?.choices?.length) {
      schema.enum = f.options.choices.map((c) => c.value);
    } else if (f.options?.values?.length) {
      schema.enum = f.options.values;
    }
    if (f.validation) {
      const v = f.validation;
      if (v.regex && (f.type === "text" || f.type === "longtext")) schema.pattern = v.regex;
      if (typeof v.min === "number") schema.minimum = v.min;
      if (typeof v.max === "number") schema.maximum = v.max;
      if (typeof v.minLength === "number") schema.minLength = v.minLength;
      if (typeof v.maxLength === "number") schema.maxLength = v.maxLength;
    }
    properties[f.name] = schema;
    if (!options.allFieldsOptional && f.required) required.push(f.name);
  }

  const out: Schema = {
    type: "object",
    title: slug,
    properties,
  };
  if (required.length) out.required = required;
  return out;
};

export const buildDynamicCollectionPaths = async (
  ctx: Ctx,
  tenantId: string,
): Promise<Record<string, unknown>> => {
  const table = ctx.dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;
  const rows = (await (ctx.db as any)
    .select({
      slug: table.slug,
      singular: table.singular,
      plural: table.plural,
      note: table.note,
      fields: table.fields,
    })
    .from(table)
    .where(eq(table.tenantId, tenantId))) as Array<{
    slug: string;
    singular: string | null;
    plural: string | null;
    note: string | null;
    fields: unknown[];
  }>;

  const paths: Record<string, unknown> = {};

  for (const row of rows) {
    const slug = row.slug;
    const tag = `items:${slug}`;
    // Presentational blocks (divider/notice) own no column — keep them out of
    // the generated request/response schemas (they never round-trip via the API).
    const fields = ((row.fields ?? []) as FieldDef[]).filter((f) => !isPresentational(f));
    const itemSchema = buildItemSchema(slug, fields, { includeId: true });
    const createSchema = buildItemSchema(slug, fields, { includeId: false });
    const patchSchema = buildItemSchema(slug, fields, {
      includeId: false,
      allFieldsOptional: true,
    });

    const description = row.note
      ? row.note
      : `Dynamic CRUD for the \`${slug}\` collection.`;

    paths[`/api/items/${slug}`] = {
      get: {
        tags: [tag],
        summary: `List ${row.plural ?? slug}`,
        description,
        parameters: [
          {
            name: "filter",
            in: "query",
            description:
              "operator-style filter JSON (e.g. `{\"status\":{\"_eq\":\"published\"}}`).",
            schema: { type: "string" },
          },
          {
            name: "sort",
            in: "query",
            description:
              "Comma-separated field list, `-` prefix = DESC. Default: `-created_at`.",
            schema: { type: "string" },
          },
          {
            name: "fields",
            in: "query",
            description: "Projection — comma-separated field names.",
            schema: { type: "string" },
          },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
          {
            name: "meta",
            in: "query",
            description: "`filter_count`, `total_count`, or `*`.",
            schema: { type: "string" },
          },
        ],
        responses: {
          200: {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: itemSchema },
                    meta: { $ref: "#/components/schemas/PaginationMeta" },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: [tag],
        summary: `Create ${row.singular ?? slug}`,
        description,
        requestBody: {
          required: true,
          content: { "application/json": { schema: createSchema } },
        },
        responses: {
          201: {
            description: "Created",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: itemSchema } },
              },
            },
          },
        },
      },
    };

    paths[`/api/items/${slug}/{id}`] = {
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      get: {
        tags: [tag],
        summary: `Read ${row.singular ?? slug}`,
        responses: {
          200: {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: itemSchema } },
              },
            },
          },
        },
      },
      patch: {
        tags: [tag],
        summary: `Update ${row.singular ?? slug}`,
        requestBody: {
          required: true,
          content: { "application/json": { schema: patchSchema } },
        },
        responses: {
          200: {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object", properties: { data: itemSchema } },
              },
            },
          },
        },
      },
      delete: {
        tags: [tag],
        summary: `Delete ${row.singular ?? slug}`,
        responses: {
          200: {
            description: "Deleted",
            content: {
              "application/json": {
                schema: { type: "object", properties: { ok: { type: "boolean" } } },
              },
            },
          },
        },
      },
    };
  }

  return paths;
};
