/**
 * `backlex templates` — the schema-template catalog over `/api/admin/templates`.
 * `list` shows the ready-made verticals; `apply <id>` seeds a vertical's
 * collections + sample data into the active workspace (idempotent);
 * `apply --file <path>` applies a custom/extracted template JSON;
 * `extract` exports the workspace schema in the same template format;
 * `clear-samples` removes every template-seeded sample row. Mirrors the SDK
 * `client.templates.*`, GraphQL `templates`/`applyTemplate`/`applyCustomTemplate`/
 * `extractTemplate`/`clearTemplateSamples`, and the MCP `templates.*` tools.
 */
import { readFileSync } from "node:fs";
import { BacklexError } from "backlex";
import {
  flag,
  has,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolveContext,
} from "./client";

interface TemplateRow {
  id: string;
  label?: string;
  category?: string;
  recommended?: boolean;
  sampleRows?: number;
  groups?: string[];
  roles?: string[];
  dashboards?: string[];
  collections?: unknown[];
}

interface ApplyResult {
  templateId: string;
  created: string[];
  skipped: string[];
  seeded: number;
  roles?: string[];
  dashboards?: string[];
}

const TEMPLATES_HELP = `backlex templates <list|apply|extract|clear-samples>

  list                       the schema-template catalog (id, category, groups, collections)
  apply <id>                 seed a template's collections + sample data (idempotent)
  apply --file <path>        apply a custom/extracted template JSON file
  extract [--collections a,b]  export the workspace schema as a template JSON (stdout)
  clear-samples              remove every template-seeded sample row
`;

const BASE = "/api/admin/templates";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const printApply = (data: ApplyResult, json: boolean): void => {
  if (json) {
    printJson(data);
    return;
  }
  printKeyValues({
    template: data.templateId,
    created: data.created.length ? data.created.join(", ") : "—",
    skipped: data.skipped.length ? data.skipped.join(", ") : "—",
    seeded: String(data.seeded),
    roles: data.roles?.length ? data.roles.join(", ") : "—",
    dashboards: data.dashboards?.length ? data.dashboards.join(", ") : "—",
  });
};

export const runTemplates = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(TEMPLATES_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "list": {
        const { data } = await client.request<{ data: TemplateRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((t) => ({
              id: t.id,
              label: t.label ?? "—",
              category: t.category ?? "—",
              recommended: t.recommended ? "yes" : "",
              groups: t.groups?.length ? t.groups.join(", ") : "—",
              collections: t.collections?.length ?? 0,
              samples: t.sampleRows ?? 0,
              bundles: [
                t.roles?.length ? `${t.roles.length} role` : null,
                t.dashboards?.length ? `${t.dashboards.length} dashboard` : null,
              ]
                .filter(Boolean)
                .join(", "),
            })),
          );
        return;
      }
      case "apply": {
        const file = flag(rest, "--file");
        if (file) {
          let template: unknown;
          try {
            template = JSON.parse(readFileSync(file, "utf8"));
          } catch (e) {
            process.stderr.write(`templates apply: cannot read ${file}: ${(e as Error).message}\n`);
            process.exit(1);
          }
          const { data } = await client.request<{ data: ApplyResult }>("POST", `${BASE}/apply`, {
            template,
          });
          printApply(data, json);
          return;
        }
        const id = rest[0];
        if (!id || id.startsWith("--")) {
          process.stderr.write("templates apply <id> | apply --file <path>\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: ApplyResult }>("POST", `${BASE}/apply`, {
          templateId: id,
        });
        printApply(data, json);
        return;
      }
      case "extract": {
        const collections = flag(rest, "--collections");
        const qs = collections ? `?collections=${encodeURIComponent(collections)}` : "";
        const { data } = await client.request<{ data: unknown }>("GET", `${BASE}/extract${qs}`);
        // Always JSON — the output IS the template file.
        printJson(data);
        return;
      }
      case "clear-samples": {
        const { data } = await client.request<{
          data: { removed: number; collections: string[] };
        }>("POST", `${BASE}/clear-samples`, {});
        if (json) printJson(data);
        else
          printKeyValues({
            removed: String(data.removed),
            collections: data.collections.length ? data.collections.join(", ") : "—",
          });
        return;
      }
      default:
        process.stderr.write(`unknown templates subcommand: ${sub}\n\n${TEMPLATES_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `templates ${sub}`);
  }
};
