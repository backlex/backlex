/**
 * `backlex s3` — credentials for the S3-compatible endpoint. See `docs/s3.md`.
 *
 * `create` prints the secret once and says so. There is no read-back path: the
 * stored copy is encrypted precisely so that a database dump does not yield it,
 * and an endpoint that decrypted it on request would undo that.
 */
import { BacklexError } from "backlex";
import { has, flag, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

interface CredentialRow {
  id: string;
  name: string;
  accessKeyId: string;
  prefix: string | null;
  readOnly: boolean;
  enabled: boolean;
  lastUsedAt: number | null;
}

const HELP = `backlex s3 <list|create|update|delete>

  list
  create --name <n> [--prefix <p>] [--read-only]
  update <id> [--name …] [--prefix …] [--read-only|--read-write]
              [--enable|--disable]
  delete <id>

  Point any S3 tool at your instance:

    aws configure set aws_access_key_id     BLX…
    aws configure set aws_secret_access_key <secret>
    aws --endpoint-url https://your-instance/s3 s3 ls s3://<workspace-slug>/

  The bucket name is the workspace slug. The credential names the workspace —
  the bucket in the URL is checked against it, never used to choose one.

  The secret is printed ONCE by \`create\`. There is no way to read it back.
`;

const BASE = "/api/admin/s3-credentials";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runS3 = async (args: string[]): Promise<void> => {
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
        const { data } = await client.request<{ data: CredentialRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((r) => ({
              id: r.id,
              name: r.name,
              "access key": r.accessKeyId,
              prefix: r.prefix ?? "—",
              mode: r.readOnly ? "read-only" : "read-write",
              status: r.enabled ? "on" : "off",
              "last used": r.lastUsedAt ? new Date(r.lastUsedAt).toISOString() : "never",
            })),
          );
        return;
      }
      case "create": {
        const name = flag(rest, "--name");
        if (!name) {
          process.stderr.write("s3 create --name <n>\n");
          process.exit(1);
        }
        const body: Record<string, unknown> = { name };
        const prefix = flag(rest, "--prefix");
        if (prefix) body.prefix = prefix;
        if (has(rest, "--read-only")) body.readOnly = true;
        const res = await client.request<{
          data: CredentialRow;
          secretAccessKey: string;
        }>("POST", BASE, body);
        if (json) {
          printJson(res);
          return;
        }
        printKeyValues({
          "access key id": res.data.accessKeyId,
          "secret access key": res.secretAccessKey,
          mode: res.data.readOnly ? "read-only" : "read-write",
          prefix: res.data.prefix ?? "(whole workspace)",
        });
        process.stdout.write(
          "\nThe secret is shown once. Store it now — there is no read-back path.\n",
        );
        return;
      }
      case "update": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("s3 update <id> …\n");
          process.exit(1);
        }
        const body: Record<string, unknown> = {};
        const name = flag(rest, "--name");
        if (name) body.name = name;
        const prefix = flag(rest, "--prefix");
        if (prefix) body.prefix = prefix;
        if (has(rest, "--read-only")) body.readOnly = true;
        if (has(rest, "--read-write")) body.readOnly = false;
        if (has(rest, "--enable")) body.enabled = true;
        if (has(rest, "--disable")) body.enabled = false;
        const res = await client.request<{ data: CredentialRow }>(
          "PATCH",
          `${BASE}/${encodeURIComponent(id)}`,
          body,
        );
        if (json) printJson(res.data);
        else process.stdout.write(`updated ${res.data.accessKeyId}\n`);
        return;
      }
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("s3 delete <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stdout.write("deleted\n");
        return;
      }
      default:
        process.stdout.write(HELP);
    }
  } catch (e) {
    die(e, `s3 ${sub}`);
  }
};
