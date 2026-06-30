/**
 * `backlex schema` — migration diffing / schema branching over
 * `/api/admin/schema`. Snapshot/branch the live schema, diff any two refs, and
 * apply a target to reconcile live. A ref is `live`, `snapshot:<id>`, or
 * `branch:<id>`. The natural GitOps loop: `collections export-schema` → edit →
 * `schema import` → `schema diff` → `schema apply`.
 */
import { BacklexError } from "backlex";
import {
  flag,
  has,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolveContext,
  resolvePayload,
} from "./client";

type Ref = { kind: "live" } | { kind: "snapshot"; id: string } | { kind: "branch"; id: string };

interface Change {
  severity: "additive" | "destructive" | "metadata";
  summary: string;
}
interface Diff {
  changes: Change[];
  counts: { additive: number; destructive: number; metadata: number; total: number };
  hasDestructive: boolean;
}

const HELP = `backlex schema <command>

  Snapshots
    snapshots                       list schema snapshots
    snapshot <id>                   one snapshot (full JSON)
    capture --name <n> [--note <s>] snapshot the live schema
    import --name <n> --data <json|@file|->
                                    store an authored schema as a snapshot
    delete-snapshot <id>

  Branches
    branches                        list schema branches
    branch <id>                     one branch
    create-branch --name <n> [--from <snapshotId>] [--note <s>]
    set-head <branchId> --data <json|@file|->   stage a schema on a branch
    set-head <branchId> --from <snapshotId>
    delete-branch <id>

  Diff / apply  (ref = live | snapshot:<id> | branch:<id>)
    diff --from <ref> --to <ref>    categorized change list
    apply --target <ref> [--confirm-destructive]
                                    reconcile live to the target ref
`;

const BASE = "/api/admin/schema";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const need = (v: string | undefined, usage: string): string => {
  if (!v) {
    process.stderr.write(`${usage}\n`);
    process.exit(1);
  }
  return v;
};

const parseRef = (raw: string | undefined, label: string): Ref => {
  const s = need(raw, `--${label} <live|snapshot:<id>|branch:<id>>`);
  if (s === "live") return { kind: "live" };
  const [kind, id] = s.split(":", 2);
  if ((kind === "snapshot" || kind === "branch") && id) return { kind, id };
  process.stderr.write(`invalid ${label} ref "${s}" — use live, snapshot:<id>, or branch:<id>\n`);
  return process.exit(1);
};

const printDiff = (d: Diff): void => {
  process.stdout.write(
    `${d.counts.total} change(s): +${d.counts.additive} additive · ${d.counts.destructive} destructive · ${d.counts.metadata} metadata\n`,
  );
  for (const ch of d.changes) {
    const mark = ch.severity === "destructive" ? "‼" : ch.severity === "additive" ? "+" : "·";
    process.stdout.write(`  ${mark} ${ch.summary}\n`);
  }
};

export const runSchema = async (args: string[]): Promise<void> => {
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
      case "snapshots": {
        const { data } = await client.request<{ data: Record<string, unknown>[] }>(
          "GET",
          `${BASE}/snapshots`,
        );
        if (json) printJson(data);
        else
          printTable(
            data.map((s) => ({
              id: s.id as string,
              name: s.name as string,
              kind: s.kind as string,
              collections: s.collectionCount as number,
            })),
          );
        return;
      }
      case "snapshot": {
        const id = need(rest[0], "schema snapshot <id>");
        const { data } = await client.request<{ data: unknown }>(
          "GET",
          `${BASE}/snapshots/${encodeURIComponent(id)}`,
        );
        printJson(data);
        return;
      }
      case "capture": {
        const name = need(flag(rest, "--name"), "schema capture --name <n> [--note <s>]");
        const { data } = await client.request<{ data: Record<string, unknown> }>(
          "POST",
          `${BASE}/snapshots`,
          { name, note: flag(rest, "--note") ?? null },
        );
        if (json) printJson(data);
        else printKeyValues({ id: data.id as string, name: data.name as string });
        return;
      }
      case "import": {
        const name = need(flag(rest, "--name"), "schema import --name <n> --data <json|@file|->");
        const snapshot = JSON.parse(await resolvePayload(flag(rest, "--data")));
        const { data } = await client.request<{ data: Record<string, unknown> }>(
          "POST",
          `${BASE}/snapshots/import`,
          { name, snapshot, note: flag(rest, "--note") ?? null },
        );
        if (json) printJson(data);
        else printKeyValues({ id: data.id as string, name: data.name as string });
        return;
      }
      case "delete-snapshot": {
        const id = need(rest[0], "schema delete-snapshot <id>");
        await client.request("DELETE", `${BASE}/snapshots/${encodeURIComponent(id)}`);
        process.stderr.write(`Deleted snapshot ${id}.\n`);
        return;
      }
      case "branches": {
        const { data } = await client.request<{ data: Record<string, unknown>[] }>(
          "GET",
          `${BASE}/branches`,
        );
        if (json) printJson(data);
        else printTable(data.map((b) => ({ id: b.id as string, name: b.name as string })));
        return;
      }
      case "branch": {
        const id = need(rest[0], "schema branch <id>");
        const { data } = await client.request<{ data: unknown }>(
          "GET",
          `${BASE}/branches/${encodeURIComponent(id)}`,
        );
        printJson(data);
        return;
      }
      case "create-branch": {
        const name = need(flag(rest, "--name"), "schema create-branch --name <n> [--from <snapshotId>]");
        const { data } = await client.request<{ data: Record<string, unknown> }>(
          "POST",
          `${BASE}/branches`,
          { name, fromSnapshotId: flag(rest, "--from") ?? null, note: flag(rest, "--note") ?? null },
        );
        if (json) printJson(data);
        else printKeyValues({ id: data.id as string, name: data.name as string });
        return;
      }
      case "set-head": {
        const id = need(rest[0], "schema set-head <branchId> --data <json|@file|-> | --from <snapshotId>");
        const dataFlag = flag(rest, "--data");
        const body = dataFlag
          ? { data: JSON.parse(await resolvePayload(dataFlag)) }
          : { fromSnapshotId: need(flag(rest, "--from"), "set-head needs --data or --from") };
        const { data } = await client.request<{ data: Record<string, unknown> }>(
          "PATCH",
          `${BASE}/branches/${encodeURIComponent(id)}/head`,
          body,
        );
        if (json) printJson(data);
        else printKeyValues({ id: data.id as string, head: data.headSnapshotId as string });
        return;
      }
      case "delete-branch": {
        const id = need(rest[0], "schema delete-branch <id>");
        await client.request("DELETE", `${BASE}/branches/${encodeURIComponent(id)}`);
        process.stderr.write(`Deleted branch ${id}.\n`);
        return;
      }
      case "diff": {
        const from = parseRef(flag(rest, "--from"), "from");
        const to = parseRef(flag(rest, "--to"), "to");
        const { data } = await client.request<{ data: { diff: Diff } }>("POST", `${BASE}/diff`, {
          from,
          to,
        });
        if (json) printJson(data);
        else printDiff(data.diff);
        return;
      }
      case "apply": {
        const target = parseRef(flag(rest, "--target"), "target");
        const confirmDestructive = has(rest, "--confirm-destructive");
        const { data } = await client.request<{
          data: { diff: Diff; applied: string[]; safetySnapshotId: string | null; noop: boolean };
        }>("POST", `${BASE}/apply`, { target, confirmDestructive });
        if (json) {
          printJson(data);
        } else if (data.noop) {
          process.stdout.write("Already in sync — no changes applied.\n");
        } else {
          printDiff(data.diff);
          process.stdout.write(
            `Applied ${data.applied.length} change(s). Safety snapshot: ${data.safetySnapshotId}\n`,
          );
        }
        return;
      }
      default:
        process.stderr.write(`unknown schema subcommand: ${sub}\n\n${HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `schema ${sub}`);
  }
};
