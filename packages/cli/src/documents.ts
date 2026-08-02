/**
 * `backlex documents` — HTML templates rendered to PDF, over
 * `/api/admin/documents`. See `docs/documents.md`.
 *
 * `render` writes the bytes to a file rather than to stdout by default. A PDF
 * on a terminal is noise, and the most common reason to run this from a shell
 * is to look at what a template actually produces.
 */
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { BacklexError } from "backlex";
import { has, flag, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

interface TemplateRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  bodyHtml: string;
  filename: string | null;
  pageOptions: Record<string, unknown>;
  inherited: boolean;
  updatedAt?: unknown;
}

const HELP = `backlex documents <list|save|delete|render>

  list
  save <key> --body-file <path> [--name <n>] [--description <d>]
             [--header-file <p>] [--footer-file <p>]
             [--filename <tpl>] [--format <A4|Letter|Legal|A3|A5>]
             [--landscape] [--margin <20mm>]
  delete <key>
  render [--template <key> | --html-file <path>]
         [--vars <json>] [--out <path>] [--stdout]

  A template body is a COMPLETE html document, not a fragment — it sets its
  own fonts, page size and print styles.

  Values are interpolated with {{ data.field }} in the body, the running
  header/footer and the filename alike. --vars takes the whole render
  context, so the usual shape is: --vars '{"data":{"no":"2026-114"}}'

  A workspace's template overrides an instance-wide default with the same
  key; saving one never changes what other workspaces render.

  There is no renderer bundled with the server. Set PDF_CF_ACCOUNT_ID +
  PDF_CF_API_TOKEN, or PDF_GOTENBERG_URL, or render fails with a message
  saying so.
`;

const BASE = "/api/admin/documents";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const readOr = (path: string | undefined, what: string): string | undefined => {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    process.stderr.write(`${what}: cannot read ${path} — ${(e as Error).message}\n`);
    process.exit(1);
  }
};

export const runDocuments = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "list": {
        const { data } = await client.request<{ data: TemplateRow[] }>("GET", `${BASE}/templates`);
        if (json) printJson(data);
        else
          printTable(
            data.map((t) => ({
              key: t.key,
              name: t.name,
              format: String(t.pageOptions?.format ?? "A4"),
              filename: t.filename ?? "",
              // The consequential column: an inherited row is a shared default
              // this workspace has not taken over.
              source: t.inherited ? "inherited" : "workspace",
            })),
          );
        return;
      }
      case "save": {
        const key = rest[0];
        if (!key) {
          process.stderr.write("documents save <key> --body-file <path>\n");
          process.exit(1);
        }
        const body: Record<string, unknown> = {};
        const bodyHtml = readOr(flag(rest, "--body-file"), "documents save");
        if (bodyHtml !== undefined) body.bodyHtml = bodyHtml;
        const headerHtml = readOr(flag(rest, "--header-file"), "documents save");
        if (headerHtml !== undefined) body.headerHtml = headerHtml;
        const footerHtml = readOr(flag(rest, "--footer-file"), "documents save");
        if (footerHtml !== undefined) body.footerHtml = footerHtml;
        const name = flag(rest, "--name");
        if (name) body.name = name;
        const description = flag(rest, "--description");
        if (description) body.description = description;
        const filename = flag(rest, "--filename");
        if (filename) body.filename = filename;

        const pageOptions: Record<string, unknown> = {};
        const format = flag(rest, "--format");
        if (format) pageOptions.format = format;
        const margin = flag(rest, "--margin");
        if (margin) pageOptions.margin = margin;
        if (has(rest, "--landscape")) pageOptions.landscape = true;
        if (Object.keys(pageOptions).length > 0) body.pageOptions = pageOptions;

        const res = await client.request<{ data: TemplateRow }>(
          "PUT",
          `${BASE}/templates/${encodeURIComponent(key)}`,
          body,
        );
        if (json) printJson(res.data);
        else
          printKeyValues({
            key: res.data.key,
            name: res.data.name,
            source: res.data.inherited ? "inherited" : "workspace",
          });
        return;
      }
      case "delete": {
        const key = rest[0];
        if (!key) {
          process.stderr.write("documents delete <key>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/templates/${encodeURIComponent(key)}`);
        if (json) printJson({ ok: true });
        else process.stdout.write(`deleted ${key}\n`);
        return;
      }
      case "render": {
        const templateKey = flag(rest, "--template");
        const html = readOr(flag(rest, "--html-file"), "documents render");
        if ((templateKey == null) === (html == null)) {
          process.stderr.write(
            "documents render needs exactly one of --template <key> or --html-file <path>\n",
          );
          process.exit(1);
        }
        let vars: Record<string, unknown> | undefined;
        const rawVars = flag(rest, "--vars");
        if (rawVars) {
          try {
            vars = JSON.parse(rawVars) as Record<string, unknown>;
          } catch {
            process.stderr.write("documents render --vars must be JSON\n");
            process.exit(1);
          }
        }
        const bytes = await client.documents.render({
          ...(templateKey ? { templateKey } : {}),
          ...(html ? { html } : {}),
          ...(vars ? { vars } : {}),
          ...(flag(rest, "--filename") ? { filename: flag(rest, "--filename")! } : {}),
        });

        if (has(rest, "--stdout")) {
          process.stdout.write(bytes);
          return;
        }
        const out = flag(rest, "--out") ?? "document.pdf";
        writeFileSync(out, bytes);
        if (json) printJson({ ok: true, path: out, bytes: bytes.byteLength });
        else process.stdout.write(`wrote ${out} (${bytes.byteLength} bytes)\n`);
        return;
      }
      default:
        process.stdout.write(HELP);
        process.exitCode = 1;
    }
  } catch (e) {
    die(e, `documents ${sub}`);
  }
};
