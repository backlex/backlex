/**
 * `backlex items` — data-plane CRUD + bulk export/import + search.
 *
 * Thin wrappers over the SDK's `from(slug)` collection client, so the CLI and
 * end-user apps share one code path (auth, error shape, the query DSL). Every
 * command takes the collection slug as its first positional arg.
 */
import { writeFileSync } from "node:fs";
import { BacklexError } from "backlex";
import {
  has,
  flag,
  buildListQuery,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolvePayload,
  resolveContext,
} from "./client";

const ITEMS_HELP = `backlex items <cmd> <slug> [args]

  list <slug>     [--filter <json>] [--sort a,-b] [--fields a,b] [--expand …]
                  [--limit N] [--offset N | --cursor <c>] [--meta filter_count] [--status …]
                  [--retired all|exclude|only]
  get <slug> <id> [--expand …] [--locale xx]
  create <slug>   --data <json|@file|-> [--locale xx]
  update <slug> <id> --data <json|@file|-> [--locale xx]
  delete <slug> <id>
  verify <slug> <id> --field <name> --value <plaintext>
  transitions <slug> <id>
  retire <slug> <id> [--restore]
  reorder <slug> <id> --field <name> (--before <id> | --after <id>)
  normalize-order <slug> [--field <name>]
  backfill-slugs <slug> [--field <name>] [--apply]
  export <slug>   [--format json|csv] [--out <file>]
  import <slug>   <file|@file|->  [--format json|csv]
  search <slug>   -q <text> [--mode fts|vector|hybrid] [--limit N] [--locale xx]
  changes <slug>  [--since <cursor>] [--shape <json>] [--fields a,b] [--limit N] [--follow]

Add --json to any read for raw output.

\`changes\` drains the incremental feed: rows changed past --since, with
soft-delete tombstones (\`_deleted\`). --shape follows only a subset; rows that
left it come back as \`{ id, _shape_exit: true }\`. --follow pages to the head.
`;

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const requireSlug = (args: string[], usage: string): string => {
  const slug = args[0];
  if (!slug || slug.startsWith("-")) {
    process.stderr.write(`${usage}\n`);
    process.exit(1);
  }
  return slug;
};

export const runItems = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(ITEMS_HELP);
    return;
  }

  const ctx = resolveContext(args);
  const client = makeClient(ctx);

  try {
    switch (sub) {
      case "list": {
        const slug = requireSlug(rest, "items list <slug> [query flags]");
        const res = await client.from(slug).list(buildListQuery(rest));
        if (json) {
          printJson(res);
        } else {
          printTable(res.data as Record<string, unknown>[]);
          if (res.meta && Object.keys(res.meta).length) {
            process.stdout.write(`\n${JSON.stringify(res.meta)}\n`);
          }
        }
        return;
      }
      case "get": {
        const slug = requireSlug(rest, "items get <slug> <id>");
        const id = rest[1];
        if (!id) {
          process.stderr.write("items get <slug> <id>\n");
          process.exit(1);
        }
        const expand = flag(rest, "--expand");
        const locale = flag(rest, "--locale");
        const res = await client.from(slug).one(id, {
          expand: expand ? expand.split(",") : undefined,
          locale: locale ?? undefined,
        });
        if (json) printJson(res);
        else printKeyValues(res.data as Record<string, unknown>);
        return;
      }
      case "create": {
        const slug = requireSlug(rest, "items create <slug> --data <json|@file|->");
        const data = JSON.parse(await resolvePayload(flag(rest, "--data"))) as Record<string, unknown>;
        const locale = flag(rest, "--locale");
        const res = await client.from(slug).create(data, locale ? { locale } : undefined);
        if (json) printJson(res);
        else printKeyValues(res.data as Record<string, unknown>);
        return;
      }
      case "update": {
        const slug = requireSlug(rest, "items update <slug> <id> --data <json|@file|->");
        const id = rest[1];
        if (!id || id.startsWith("-")) {
          process.stderr.write("items update <slug> <id> --data <json|@file|->\n");
          process.exit(1);
        }
        const patch = JSON.parse(await resolvePayload(flag(rest, "--data"))) as Record<string, unknown>;
        const locale = flag(rest, "--locale");
        const res = await client.from(slug).update(id, patch, locale ? { locale } : undefined);
        if (json) printJson(res);
        else printKeyValues(res.data as Record<string, unknown>);
        return;
      }
      case "delete": {
        const slug = requireSlug(rest, "items delete <slug> <id>");
        const id = rest[1];
        if (!id) {
          process.stderr.write("items delete <slug> <id>\n");
          process.exit(1);
        }
        const res = await client.from(slug).delete(id);
        if (json) printJson(res);
        else process.stdout.write(res.ok ? "deleted\n" : "not deleted\n");
        return;
      }
      case "verify": {
        const slug = requireSlug(rest, "items verify <slug> <id> --field <name> --value <plaintext>");
        const id = rest[1];
        if (!id || id.startsWith("-")) {
          process.stderr.write("items verify <slug> <id> --field <name> --value <plaintext>\n");
          process.exit(1);
        }
        const field = flag(rest, "--field");
        const value = flag(rest, "--value");
        if (!field || value == null) {
          process.stderr.write("items verify requires --field and --value\n");
          process.exit(1);
        }
        const res = await client.from(slug).verify(id, field, value);
        if (json) printJson(res);
        else process.stdout.write(res.valid ? "valid\n" : "invalid\n");
        return;
      }
      case "transitions": {
        const slug = requireSlug(rest, "items transitions <slug> <id>");
        const id = rest[1];
        if (!id || id.startsWith("-")) {
          process.stderr.write("items transitions <slug> <id>\n");
          process.exit(1);
        }
        const res = await client.from(slug).transitions(id);
        if (json) printJson(res);
        else if (res.data.length === 0) {
          process.stdout.write("no lifecycle fields on this collection\n");
        } else {
          for (const f of res.data) {
            const state = f.terminal ? " (final)" : "";
            process.stdout.write(`${f.field}: ${f.current ?? "—"}${state}\n`);
            for (const m of f.moves) {
              const why = m.allowed ? "" : `  — ${m.reason ?? "refused"}`;
              process.stdout.write(`  ${m.allowed ? "→" : "✗"} ${m.to}${why}\n`);
            }
          }
        }
        return;
      }
      case "retire": {
        const usage = "items retire <slug> <id> [--restore]";
        const slug = requireSlug(rest, usage);
        const id = rest[1];
        if (!id || id.startsWith("-")) {
          process.stderr.write(`${usage}\n`);
          process.exit(1);
        }
        const restore = rest.includes("--restore");
        const res = await client.from(slug).retire(id, restore ? { restore: true } : undefined);
        if (json) printJson(res);
        else {
          // Says what happened to the ROW, not what was written to the column:
          // half the schemas spell the flag `active` and the other half spell
          // it the other way round, and "set discontinued = true" reads as the
          // opposite of what it did.
          process.stdout.write(
            `${res.retired ? "retired" : "restored"} ${id} (${res.field})\n`,
          );
        }
        return;
      }
      case "reorder": {
        const usage =
          "items reorder <slug> <id> --field <name> (--before <id> | --after <id>)";
        const slug = requireSlug(rest, usage);
        const id = rest[1];
        if (!id || id.startsWith("-")) {
          process.stderr.write(`${usage}\n`);
          process.exit(1);
        }
        const field = flag(rest, "--field");
        const before = flag(rest, "--before");
        const after = flag(rest, "--after");
        // Exactly one anchor — accepting both would mean picking one silently.
        if (!field || (before == null) === (after == null)) {
          process.stderr.write(`${usage}\n`);
          process.exit(1);
        }
        const res = await client
          .from(slug)
          .reorder(field, id, before != null ? { before } : { after: after! });
        if (json) printJson(res);
        else {
          const repaired = res.repaired > 0 ? `, repaired ${res.repaired}` : "";
          process.stdout.write(
            `moved to position ${res.position} (shifted ${res.shifted}${repaired})\n`,
          );
        }
        return;
      }
      case "normalize-order": {
        const slug = requireSlug(rest, "items normalize-order <slug> [--field <name>]");
        const res = await client.from(slug).normalizeOrder(flag(rest, "--field") ?? undefined);
        if (json) printJson(res);
        else {
          process.stdout.write(
            `renumbered ${res.renumbered} row(s) across ${res.scopes} list(s): ${
              res.fields.join(", ") || "no order fields"
            }\n`,
          );
        }
        return;
      }
      case "backfill-slugs": {
        const slug = requireSlug(rest, "items backfill-slugs <slug> [--field <name>] [--apply]");
        // Dry run unless --apply is passed: this writes a public URL onto rows
        // the caller did not name, so the report comes first.
        const apply = rest.includes("--apply");
        const field = flag(rest, "--field") ?? undefined;
        const res = await client
          .from(slug)
          .backfillSlugs({ ...(field ? { field } : {}), ...(apply ? { apply: true } : {}) });
        if (json) printJson(res);
        else {
          for (const f of res.fields) {
            const unfoldable = f.unfoldable ? `, ${f.unfoldable} unfoldable` : "";
            process.stdout.write(
              `${f.field}: ${res.dryRun ? "would fill" : "filled"} ${f.filled} of ${f.examined} empty${unfoldable}\n`,
            );
            for (const e of f.entries) process.stdout.write(`  ${e.id} → ${e.slug}\n`);
          }
          if (res.fields.length === 0) process.stdout.write("no slug fields\n");
          else if (res.dryRun) process.stdout.write("dry run — re-run with --apply to write\n");
        }
        return;
      }
      case "export": {
        const slug = requireSlug(rest, "items export <slug> [--format json|csv] [--out <file>]");
        const format = flag(rest, "--format") === "csv" ? "csv" : "json";
        const out = await client.from(slug).exportItems(format);
        const outPath = flag(rest, "--out");
        if (outPath) {
          writeFileSync(outPath, out, "utf8");
          process.stderr.write(`✓ wrote ${slug} (${format}) → ${outPath}\n`);
        } else {
          process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
        }
        return;
      }
      case "import": {
        const slug = requireSlug(rest, "items import <slug> <file|@file|->  [--format json|csv]");
        const source = rest[1];
        if (!source) {
          process.stderr.write("items import <slug> <file|@file|->\n");
          process.exit(1);
        }
        const format = flag(rest, "--format") === "csv" ? "csv" : "json";
        // A bare path is treated as @path; `-` is stdin; `@path` also works.
        const ref = source === "-" || source.startsWith("@") ? source : `@${source}`;
        const body = await resolvePayload(ref);
        const summary = await client.from(slug).importItems(body, format);
        if (json) printJson(summary);
        else {
          printKeyValues({
            inserted: summary.inserted,
            failed: summary.failed,
            total: summary.total,
          });
          if (summary.errors.length) {
            process.stdout.write("\nerrors:\n");
            printTable(summary.errors as unknown as Record<string, unknown>[]);
          }
        }
        return;
      }
      case "search": {
        const slug = requireSlug(rest, "items search <slug> -q <text>");
        const q = flag(rest, "-q") ?? flag(rest, "--q");
        if (!q) {
          process.stderr.write("items search <slug> -q <text>\n");
          process.exit(1);
        }
        const modeRaw = flag(rest, "--mode");
        const mode =
          modeRaw === "fts" || modeRaw === "vector" || modeRaw === "hybrid" ? modeRaw : undefined;
        const limit = flag(rest, "--limit");
        const res = await client.from(slug).search({
          q,
          mode,
          limit: limit ? Number(limit) : undefined,
          locale: flag(rest, "--locale") ?? undefined,
        });
        if (json) printJson(res);
        else {
          process.stderr.write(`mode=${res.mode} limit=${res.limit}\n`);
          printTable(res.data as Record<string, unknown>[]);
        }
        return;
      }
      case "changes": {
        const slug = requireSlug(rest, "items changes <slug> [--since <cursor>]");
        const shapeRaw = flag(rest, "--shape");
        let shape: Record<string, unknown> | undefined;
        if (shapeRaw) {
          try {
            shape = JSON.parse(shapeRaw) as Record<string, unknown>;
          } catch {
            process.stderr.write("--shape must be valid JSON\n");
            process.exit(1);
          }
        }
        const limit = flag(rest, "--limit");
        const fieldsRaw = flag(rest, "--fields");
        // `--follow` drains every page to the head, so a scripted sync can grab
        // the whole delta in one command instead of shell-looping on the cursor.
        const follow = has(rest, "--follow");
        const all: Record<string, unknown>[] = [];
        let cursor = flag(rest, "--since") ?? undefined;
        let hasMore = false;
        let shapeKeyOut: string | undefined;
        do {
          const page = await client.from(slug).changes({
            since: cursor,
            limit: limit ? Number(limit) : undefined,
            shape: shape as never,
            fields: fieldsRaw ? fieldsRaw.split(",").map((f) => f.trim()) : undefined,
          });
          all.push(...(page.data as Record<string, unknown>[]));
          cursor = page.cursor ?? cursor;
          hasMore = page.hasMore;
          shapeKeyOut = page.shape;
        } while (follow && hasMore);

        if (json) {
          printJson({ data: all, cursor: cursor ?? null, hasMore, ...(shapeKeyOut ? { shape: shapeKeyOut } : {}) });
        } else {
          printTable(all);
          process.stderr.write(
            `\ncursor=${cursor ?? "-"} hasMore=${hasMore}${shapeKeyOut ? ` shape=${shapeKeyOut}` : ""}\n`,
          );
        }
        return;
      }
      default:
        process.stderr.write(`unknown items subcommand: ${sub}\n\n${ITEMS_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `items ${sub}`);
  }
};
