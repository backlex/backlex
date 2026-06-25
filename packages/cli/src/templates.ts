/**
 * `backlex templates` — the schema-template catalog over `/api/admin/templates`.
 * `list` shows the ready-made verticals; `apply <id>` seeds a vertical's
 * collections + sample data into the active workspace (idempotent). Mirrors the
 * SDK `client.templates.*`, GraphQL `templates`/`applyTemplate`, and the MCP
 * `templates.*` tools.
 */
import { BacklexError } from "backlex";
import {
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
  collections?: unknown[];
}

const TEMPLATES_HELP = `backlex templates <list|apply>

  list                  the schema-template catalog (id, category, collections)
  apply <id>            seed a template's collections + sample data (idempotent)
`;

const BASE = "/api/admin/templates";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
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
              collections: t.collections?.length ?? 0,
              samples: t.sampleRows ?? 0,
            })),
          );
        return;
      }
      case "apply": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("templates apply <id>\n");
          process.exit(1);
        }
        const { data } = await client.request<{
          data: { templateId: string; created: string[]; skipped: string[]; seeded: number };
        }>("POST", `${BASE}/apply`, { templateId: id });
        if (json) printJson(data);
        else
          printKeyValues({
            template: data.templateId,
            created: data.created.length ? data.created.join(", ") : "—",
            skipped: data.skipped.length ? data.skipped.join(", ") : "—",
            seeded: String(data.seeded),
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
