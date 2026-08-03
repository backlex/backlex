/**
 * `backlex collections` — inspect the schema of the connected instance.
 *
 * `list` is the dynamic "what can I reach here?" surface: it shows every
 * collection the key can read. `export-schema` dumps the full field metadata as
 * JSON so it can be committed and diffed (GitOps), the seed for a future
 * `apply-schema`. All reads go through `GET /api/collections`.
 */
import { writeFileSync } from "node:fs";
import { BacklexError } from "backlex";
import {
  has,
  flag,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolveContext,
} from "./client";

interface Field {
  name: string;
  type: string;
  required?: boolean;
}
interface Collection {
  slug: string;
  singular?: string | null;
  fields: Field[];
  ownerScoped: boolean | number;
  physicalTable?: string;
  adopted?: boolean | number;
}

const COLLECTIONS_HELP = `backlex collections <list|get|clone|export-schema|drop-field|fts-reindex|vectorize|refresh-rollups>

  list                              every collection the key can read
  get <slug>                        one collection's fields
  clone <slug> <new-slug>           duplicate a collection's schema (fields +
                                    metadata; never copies data)
  export-schema [--out <file>]      full schema as JSON (commit + diff for GitOps)
  drop-field <slug> <field>         drop a column (destructive; managed-only)
  fts-reindex <slug>                rebuild the full-text index for existing rows
                                    (rarely needed — enabling fts auto-backfills)
  vectorize <slug>                  embed every existing row into the vector store
                                    (manual by design: each row costs a provider call)
  refresh-rollups <slug>            restate the collection's rollup columns from
                                    the rows they aggregate (repair path — writes
                                    keep them in step on their own)
`;

const fetchCollections = (args: string[]): Promise<Collection[]> => {
  const ctx = resolveContext(args);
  return makeClient(ctx)
    .request<{ data: Collection[] }>("GET", "/api/collections")
    .then((r) => r.data);
};

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runCollections = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(COLLECTIONS_HELP);
    return;
  }

  if (sub === "list") {
    try {
      const cols = await fetchCollections(args.slice(1));
      if (json) {
        printJson(cols);
        return;
      }
      printTable(
        cols.map((c) => ({
          slug: c.slug,
          fields: c.fields.length,
          ownerScoped: c.ownerScoped ? "yes" : "no",
          adopted: c.adopted ? "yes" : "no",
        })),
      );
    } catch (e) {
      die(e, "collections list");
    }
    return;
  }

  if (sub === "get") {
    const slug = args[1];
    if (!slug) {
      process.stderr.write("collections get <slug>\n");
      process.exit(1);
    }
    try {
      const cols = await fetchCollections(args.slice(2));
      const col = cols.find((c) => c.slug === slug);
      if (!col) {
        process.stderr.write(`no such collection: ${slug}\n`);
        process.exit(1);
      }
      if (json) {
        printJson(col);
        return;
      }
      printKeyValues({
        slug: col.slug,
        singular: col.singular ?? "—",
        ownerScoped: col.ownerScoped ? "yes" : "no",
        adopted: col.adopted ? "yes" : "no",
      });
      process.stdout.write("\nfields:\n");
      printTable(
        col.fields.map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required ? "yes" : "no",
        })),
      );
    } catch (e) {
      die(e, "collections get");
    }
    return;
  }

  if (sub === "clone") {
    const slug = args[1];
    const newSlug = args[2];
    if (!slug || !newSlug) {
      process.stderr.write("collections clone <slug> <new-slug>\n");
      process.exit(1);
    }
    try {
      const ctx = resolveContext(args.slice(3));
      const res = await makeClient(ctx).request<{ data: Collection }>(
        "POST",
        `/api/collections/${encodeURIComponent(slug)}/clone`,
        { slug: newSlug },
      );
      if (json) {
        printJson(res.data);
        return;
      }
      process.stderr.write(`✓ cloned ${slug} → ${res.data.slug} (schema only, no data)\n`);
    } catch (e) {
      die(e, "collections clone");
    }
    return;
  }

  if (sub === "export-schema") {
    try {
      const cols = await fetchCollections(args.slice(1));
      const out = `${JSON.stringify(cols, null, 2)}\n`;
      const outPath = flag(args, "--out");
      if (outPath) {
        writeFileSync(outPath, out, "utf8");
        process.stderr.write(`✓ wrote ${cols.length} collection(s) → ${outPath}\n`);
      } else {
        process.stdout.write(out);
      }
    } catch (e) {
      die(e, "collections export-schema");
    }
    return;
  }

  if (sub === "drop-field") {
    const slug = args[1];
    const field = args[2];
    if (!slug || !field) {
      process.stderr.write("collections drop-field <slug> <field>\n");
      process.exit(1);
    }
    try {
      const ctx = resolveContext(args.slice(3));
      const res = await makeClient(ctx).request<{ ok: true; slug: string; field: string }>(
        "DELETE",
        `/api/collections/${encodeURIComponent(slug)}/fields/${encodeURIComponent(field)}`,
      );
      if (json) {
        printJson(res);
        return;
      }
      process.stderr.write(`✓ dropped ${field} from ${res.slug}\n`);
    } catch (e) {
      die(e, "collections drop-field");
    }
    return;
  }

  // Restate every rollup column on the collection. Reported separately from
  // the two backfills below because it counts COLUMNS, not rows — one
  // statement per rollup field, however many parents it touches.
  if (sub === "refresh-rollups") {
    const slug = args[1];
    if (!slug) {
      process.stderr.write("collections refresh-rollups <slug>\n");
      process.exit(1);
    }
    try {
      const ctx = resolveContext(args.slice(2));
      const res = await makeClient(ctx).request<{ ok: true; refreshed: string[] }>(
        "POST",
        `/api/items/${encodeURIComponent(slug)}/rollups/refresh`,
      );
      if (json) {
        printJson(res);
        return;
      }
      process.stderr.write(
        res.refreshed.length
          ? `✓ ${slug}: refreshed ${res.refreshed.join(", ")}\n`
          : `✓ ${slug}: no rollup fields to refresh\n`,
      );
    } catch (e) {
      die(e, "collections refresh-rollups");
    }
    return;
  }

  // fts-reindex + vectorize share one shape: POST an empty body to the
  // collection's backfill endpoint and report the processed/skipped counts.
  if (sub === "fts-reindex" || sub === "vectorize") {
    const slug = args[1];
    if (!slug) {
      process.stderr.write(`collections ${sub} <slug>\n`);
      process.exit(1);
    }
    const path =
      sub === "fts-reindex"
        ? `/api/collections/${encodeURIComponent(slug)}/fts-reindex`
        : `/api/collections/${encodeURIComponent(slug)}/vectorize`;
    try {
      const ctx = resolveContext(args.slice(2));
      const res = await makeClient(ctx).request<{
        ok: true;
        processed: number;
        skipped: number;
        total: number;
      }>("POST", path);
      if (json) {
        printJson(res);
        return;
      }
      const verb = sub === "fts-reindex" ? "indexed" : "embedded";
      process.stderr.write(
        `✓ ${slug}: ${res.processed} ${verb}, ${res.skipped} empty, ${res.total} total\n`,
      );
    } catch (e) {
      die(e, `collections ${sub}`);
    }
    return;
  }

  process.stderr.write(`unknown collections subcommand: ${sub}\n\n${COLLECTIONS_HELP}`);
  process.exit(1);
};
