/**
 * `POST /api/items/{slug}/ingest` — a stored document becomes rows.
 *
 * The neighbour of `/import`, and built on the same write pipeline
 * (`performCreate` + `WriteEnv`), so every hook an ordinary create fires still
 * fires here: validation, sequences, audit, the full-text index, and — the
 * point of the exercise — vectorization. Ingest itself knows nothing about
 * embeddings; it produces rows, and the collection's own `vectorize` flags do
 * the rest.
 *
 * One row per SECTION rather than per document. A single-row ingest would run
 * into the chunk cap (`MAX_CHUNKS` bounds a row at about 64 KB of indexed
 * text) and silently stop indexing a long handbook part-way through; sections
 * keep every row short, and they are the granularity retrieval wants anyway —
 * a search should answer with the section, not with a document to go read.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../../app";
import { requirePermission } from "../../middleware/permission";
import { resolvePermission } from "../../services/permissions";
import { elapsedMs, requestMeta } from "../../services/activity";
import { SECURITY, errorResponses } from "../../lib/openapi";
import { collectionFromParam, loadCollection } from "../../services/items/collection-loader";
import {
  performCreate,
  performDelete,
  type ResolvedPerm,
  type WriteEnv,
} from "../../services/items/write";
import {
  deletedFilter,
  fromOf,
  queryAll,
  tenantFilter,
  whereOf,
} from "../../services/items/sql-helpers";
import { allocateSequenceValues, sequenceFieldsOf } from "../../services/items/sequence";
import { extractText, splitSections } from "../../services/ingest";
import { guardLogicalKey, physicalKey, requireTenantId } from "../../services/storage/keys";
import { aclForKey } from "../../services/storage/files";
import { bucketFor } from "../../services/storage/bucket-for";
import { defaultHook } from "../../lib/openapi-router";

const TAGS = ["items"];

/**
 * Bytes we will pull into memory for one ingest.
 *
 * Text-native formats only, so this is generous for anything legitimately
 * ingestible — and it is a memory bound, not a policy: a Worker isolate has to
 * hold the whole decoded string plus its sections.
 */
const MAX_BYTES = 8 * 1024 * 1024;

/** Rows one call may create, so a pathological document cannot become a write
 *  storm. Mirrors `IMPORT_MAX`'s reasoning at the size sections come in. */
const MAX_SECTIONS = 500;

const IngestInput = z
  .object({
    key: z
      .string()
      .min(1)
      .openapi({ description: "Storage key of the document, as `/api/storage` lists it." }),
    bodyField: z
      .string()
      .min(1)
      .openapi({ description: "Field each section's text is written to." }),
    titleField: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: "Field for the section's heading, when the document had one." }),
    sourceField: z.string().min(1).optional().openapi({
      description:
        "Field set to `key` on every row. Required by `replace`, and what makes a re-ingest identifiable later.",
    }),
    sectionField: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: "Field for the section's 0-based position in the document." }),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({ description: "Constants merged into every row (a category, an owner…)." }),
    replace: z.boolean().optional().openapi({
      description:
        "Delete this document's existing rows first, matched on `sourceField`. Needs `delete` permission, and `sourceField` — without one there is no way to tell which rows came from this document.",
    }),
  })
  .openapi("ItemIngestInput");

export const itemsIngestRoutes = new OpenAPIHono<AppBindings>({ defaultHook }).openapi(
  createRoute({
    method: "post",
    path: "/{slug}/ingest",
    tags: TAGS,
    summary: "Ingest a stored document as rows",
    description:
      "Reads a document from storage, splits it into sections, and creates one row per section — ready for the collection's own full-text and vector indexes. Markdown headings are the section boundary when the document has them, paragraphs otherwise. Text-native formats only (`.txt`, `.md`, `.html`, `.csv`, `.json`); PDF and Office documents are refused by name, since extracting them needs a per-runtime capability. Rows go through the ordinary create path, so validation, permissions and every write hook apply.",
    security: SECURITY,
    middleware: [requirePermission(collectionFromParam, "create")],
    request: {
      params: z.object({ slug: z.string() }),
      body: { required: true, content: { "application/json": { schema: IngestInput } } },
    },
    responses: {
      200: {
        description: "Ingest summary",
        content: {
          "application/json": {
            schema: z.object({
              data: z.object({
                key: z.string(),
                sections: z.number().int(),
                inserted: z.number().int(),
                replaced: z.number().int(),
                failed: z.number().int(),
                errors: z.array(z.object({ section: z.number().int(), error: z.string() })),
              }),
            }),
          },
        },
      },
      ...errorResponses,
    },
  }),
  async (c) => {
    const ctx = c.get("ctx");
    const auth = c.get("auth");
    const perm = c.get("permission");
    const collection = await loadCollection(ctx, auth.tenantId, c.req.param("slug"));
    const input = c.req.valid("json");

    // Tenant isolation is structural rather than checked: the caller names a
    // LOGICAL key and the physical one is built under their own tenant prefix,
    // so there is no key they can spell that reaches another workspace's
    // bucket. `guardLogicalKey` is what stops them spelling their way out of
    // the prefix (traversal, absolute paths, reserved prefix).
    const tenantId = requireTenantId(auth);
    guardLogicalKey(input.key);
    const key = physicalKey(tenantId, input.key);

    // Every field name here is caller-supplied, and `sourceField` reaches a
    // `sql.identifier` in the replace path. Quoting already rules out
    // injection, but an unchecked name is still worth refusing: an unknown
    // column turns into a 500 that reads as a server fault and doubles as a
    // column-existence oracle, and a name that IS a column but not the
    // intended one would widen what `replace` deletes.
    const known = new Set(collection.fields.map((f) => f.name));
    for (const [param, name] of [
      ["bodyField", input.bodyField],
      ["titleField", input.titleField],
      ["sourceField", input.sourceField],
      ["sectionField", input.sectionField],
    ] as const) {
      if (name && !known.has(name)) {
        throw new AppError(
          "VALIDATION",
          `${param}: "${name}" is not a field of collection "${collection.slug}".`,
        );
      }
    }

    // Read through the ACL-aware bucket resolver: public objects live in a
    // different bucket on split-bucket deployments, and reading the wrong one
    // is a 404 that looks like a missing file.
    const object = await bucketFor(ctx, await aclForKey(ctx, key)).get(key);
    if (!object) throw new AppError("NOT_FOUND", `No stored object at "${input.key}"`);
    if (object.meta.size > MAX_BYTES) {
      throw new AppError(
        "VALIDATION",
        `Document is ${object.meta.size} bytes; ingest is limited to ${MAX_BYTES}.`,
      );
    }

    const bytes = await new Response(object.body).arrayBuffer();
    const text = extractText(bytes, object.meta.contentType, input.key);
    const sections = splitSections(text);
    if (sections.length === 0) {
      throw new AppError("VALIDATION", `"${input.key}" decoded to no text.`);
    }
    if (sections.length > MAX_SECTIONS) {
      throw new AppError(
        "VALIDATION",
        `Document splits into ${sections.length} sections; ingest is limited to ${MAX_SECTIONS} per call.`,
      );
    }

    // `replace` is a delete, so it needs the delete permission in its own
    // right — the route's gate is `create`. Refusing loudly beats quietly
    // ingesting a second copy alongside the first.
    // Resolved before the write env is built, so an unauthorised `replace`
    // refuses before anything is created — the alternative is a partial ingest
    // sitting next to the copy it was meant to replace.
    let replaceWith: {
      sourceField: string;
      perm: ResolvedPerm;
    } | null = null;
    if (input.replace) {
      if (!input.sourceField) {
        throw new AppError("VALIDATION", "`replace` needs `sourceField` to identify prior rows.");
      }
      const del = await resolvePermission(ctx, auth, collection.slug, "delete");
      if (!del.allowed) {
        throw new AppError("FORBIDDEN", "`replace` requires delete permission on this collection.");
      }
      replaceWith = {
        sourceField: input.sourceField,
        perm: { whereSql: del.whereSql, fields: del.fields, conditions: del.conditions },
      };
    }

    const env: WriteEnv = {
      ctx,
      collection,
      userId: auth.userId,
      tenantId: auth.tenantId,
      roles: auth.roles,
      email: auth.email ?? null,
      orgId: auth.orgId ?? null,
      orgRole: auth.orgRole ?? null,
      orgIds: auth.orgIds ?? [],
      meta: requestMeta(c.req.raw, c.get("ctx").env),
      impersonatedBy: auth.impersonatedBy ?? null,
      impersonationReadOnly: auth.impersonationReadOnly ?? false,
      durationMs: () => elapsedMs(c),
      locale: null,
      // Answers with a summary, never a row — same restrictive default the
      // import path takes, so a change that starts echoing rows inherits it.
      readFields: new Set<string>(),
      // Same reasoning as `/import`: a geocoder is metered, and one call per
      // section would make a large document a request that cannot finish.
      skipGeocode: true,
      sequencePool: await allocateSequenceValues(
        ctx,
        auth.tenantId,
        collection.slug,
        sequenceFieldsOf(collection.fields),
        sections.length,
        new Date(),
      ),
    };

    const replaced = replaceWith
      ? await deletePriorRows(env, auth, replaceWith.sourceField, input.key, replaceWith.perm)
      : 0;

    let inserted = 0;
    const errors: { section: number; error: string }[] = [];
    for (const section of sections) {
      const row: Record<string, unknown> = {
        ...(input.data ?? {}),
        [input.bodyField]: section.body,
      };
      if (input.titleField && section.title) row[input.titleField] = section.title;
      if (input.sourceField) row[input.sourceField] = input.key;
      if (input.sectionField) row[input.sectionField] = section.index;
      try {
        const res = await performCreate(env, row, { whereSql: perm.whereSql, fields: perm.fields, conditions: perm.conditions });
        for (const fx of res.sideEffects) await fx();
        inserted += 1;
      } catch (e) {
        errors.push({ section: section.index, error: (e as Error).message.slice(0, 200) });
      }
    }

    return c.json({
      data: {
        key: input.key,
        sections: sections.length,
        inserted,
        replaced,
        failed: errors.length,
        errors: errors.slice(0, 50),
      },
    });
  },
);

/**
 * Delete the rows a previous ingest of this document created.
 *
 * Through `performDelete`, one row at a time, and NOT a `DELETE … WHERE` —
 * which is what a first draft of this did. A raw delete skips every hook the
 * write path owns, and the one that matters here is `deleteVector`: the rows
 * would go and their embeddings would stay, still matching queries for text no
 * row holds any more. Soft-delete, revisions and the audit trail hang off the
 * same path.
 *
 * The id lookup carries the caller's own delete-permission clause and the
 * tenant filter, so `replace` can never remove a row the caller could not have
 * deleted by hand.
 */
const deletePriorRows = async (
  env: WriteEnv,
  auth: { tenantId?: string | null },
  sourceField: string,
  key: string,
  perm: ResolvedPerm,
): Promise<number> => {
  const { collection, ctx } = env;
  const ids = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${sql.identifier(collection.pkColumn)} AS id FROM ${fromOf(collection)} ${whereOf(
      sql`${sql.identifier(sourceField)} = ${key}`,
      perm.whereSql,
      tenantFilter(collection, auth as never),
      deletedFilter(collection),
    )}`,
  );
  let removed = 0;
  for (const row of ids) {
    const res = await performDelete(env, String(row.id), perm);
    for (const fx of res.sideEffects) await fx();
    removed += 1;
  }
  return removed;
};
