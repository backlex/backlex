/**
 * `backlex forms` — public form builder over `/api/admin/forms`. `create` /
 * `rotate-token` print the ONE-TIME plaintext token + public URLs; the token
 * is never retrievable afterwards.
 */
import { BacklexError } from "backlex";
import {
  has,
  flag,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolvePayload,
  resolveContext,
} from "./client";

interface FormRow {
  id: string;
  name?: string;
  collection?: string;
  fields?: unknown[];
  active?: boolean;
}

const HELP = `backlex forms <list|get|fields|create|update|rotate-token|delete>

  list                            all forms
  get <id>                        one form (full JSON)
  fields <collection>             the collection's form-eligible fields
  create --data <json|@file|->    create a form ({ name, collection, fields, settings? })
                                  prints the one-time public token + URLs
  update <id> --data <json|@file|->  partial update (fields, settings, active …)
  rotate-token <id>               replace the public link (old one dies)
  delete <id>
`;

const BASE = "/api/admin/forms";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runForms = async (args: string[]): Promise<void> => {
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
        const { data } = await client.request<{ data: FormRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((f) => ({
              id: f.id,
              name: f.name ?? "—",
              collection: f.collection ?? "—",
              fields: String(f.fields?.length ?? 0),
              active: f.active ? "yes" : "no",
            })),
          );
        return;
      }
      case "get": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("forms get <id>\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: Record<string, unknown> }>(
          "GET",
          `${BASE}/${encodeURIComponent(id)}`,
        );
        printJson(data);
        return;
      }
      case "fields": {
        const collection = rest[0];
        if (!collection) {
          process.stderr.write("forms fields <collection>\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: Record<string, unknown>[] }>(
          "GET",
          `${BASE}/eligible-fields/${encodeURIComponent(collection)}`,
        );
        if (json) printJson(data);
        else printTable(data as Array<Record<string, string>>);
        return;
      }
      case "create": {
        const data = JSON.parse(await resolvePayload(flag(rest, "--data"))) as Record<string, unknown>;
        const res = await client.request<{
          data: { form: { id: string; name?: string }; token: string; url: string; embedUrl: string };
        }>("POST", BASE, data);
        if (json) printJson(res.data);
        else
          printKeyValues({
            id: res.data.form.id,
            name: res.data.form.name ?? "—",
            token: res.data.token,
            url: res.data.url,
            embedUrl: res.data.embedUrl,
          });
        return;
      }
      case "update": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("forms update <id> --data <json|@file|->\n");
          process.exit(1);
        }
        const data = JSON.parse(await resolvePayload(flag(rest, "--data"))) as Record<string, unknown>;
        const res = await client.request<{ data: Record<string, unknown> }>(
          "PATCH",
          `${BASE}/${encodeURIComponent(id)}`,
          data,
        );
        printJson(res.data);
        return;
      }
      case "rotate-token": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("forms rotate-token <id>\n");
          process.exit(1);
        }
        const res = await client.request<{ data: { token: string; url: string; embedUrl: string } }>(
          "POST",
          `${BASE}/${encodeURIComponent(id)}/rotate-token`,
        );
        if (json) printJson(res.data);
        else printKeyValues(res.data);
        return;
      }
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("forms delete <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stderr.write(`Deleted form ${id}.\n`);
        return;
      }
      default:
        process.stderr.write(`unknown forms subcommand: ${sub}\n\n${HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `forms ${sub}`);
  }
};
