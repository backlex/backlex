/**
 * `backlex rls` — the workspace's permission rules, compiled into Postgres
 * row-level security. See `docs/rls.md`.
 *
 * `plan` prints the statements AND the omissions. The omissions are the point:
 * they are the parts of the permission model a policy cannot carry, and an
 * operator who applies without reading them believes their database enforces
 * something it does not.
 */
import { BacklexError } from "backlex";
import { has, makeClient, printJson, printKeyValues, resolveContext } from "./client";

interface Omission {
  collection: string;
  role: string;
  action: string;
  reason: string;
}

const HELP = `backlex rls <status|plan|apply|disable>

  status     what is installed, and how far it has drifted from the rules
  plan       the exact statements an apply would run (changes nothing)
  apply      install the policies (idempotent)
  disable    drop backlex's policies

  Postgres only. On SQLite/D1 the API stays the only enforcement point.

  backlex connects as the table owner, and row security exempts the owner —
  so applying cannot change anything the API does. It only affects OTHER
  connections: psql, a BI tool, a warehouse connector.

  A policy reads the connected identity from session settings:

    SET backlex.user_id  = 'usr_123';
    SET backlex.roles    = 'editor,viewer';
    SET backlex.tenant_id = 'wsp_abc';

  (a PostgREST-shaped \`request.jwt.claims\` blob is accepted too). A connection
  that sets NONE of them is nobody, and sees nothing.
`;

const BASE = "/api/admin/rls";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const printOmissions = (omissions: Omission[]): void => {
  if (!omissions.length) return;
  process.stdout.write(
    `\n${omissions.length} part(s) of your permission rules cannot be carried by a policy —\n` +
      "a direct database reader sees a COARSER view than the API here:\n\n",
  );
  for (const o of omissions) {
    process.stdout.write(`  ${o.collection} · ${o.role} · ${o.action}\n    ${o.reason}\n`);
  }
};

export const runRls = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "status": {
        const res = await client.request<{
          supported: boolean;
          appliesTo: string;
          installed: unknown[];
          expected: unknown[];
          stale: { table: string; name: string }[];
          missing: { table: string; name: string }[];
          omissions: Omission[];
          notOwned: string[];
        }>("GET", `${BASE}/status`);
        if (json) {
          printJson(res);
          return;
        }
        if (!res.supported) {
          process.stdout.write(
            "Row-level security is a Postgres feature; this instance is on SQLite/D1.\n" +
              "The API remains the only enforcement point.\n",
          );
          return;
        }
        printKeyValues({
          "applies to": res.appliesTo,
          installed: String(res.installed.length),
          expected: String(res.expected.length),
          // The two that mean "the database and the API disagree right now".
          stale: String(res.stale.length),
          missing: String(res.missing.length),
        });
        if (res.notOwned.length) {
          process.stdout.write(
            `\nNOT OWNED by backlex: ${res.notOwned.join(", ")}\n` +
              "Applying is refused while any table is listed here — enabling row security on a\n" +
              "table this connection does not own would filter backlex's own queries.\n",
          );
        }
        if (res.stale.length || res.missing.length) {
          process.stdout.write("\nRun `backlex rls apply` to bring the database back in line.\n");
        }
        printOmissions(res.omissions);
        return;
      }
      case "plan": {
        const res = await client.request<{
          helpers: string[];
          enables: string[];
          policies: { collection: string; role: string; action: string; statements: string[] }[];
          omissions: Omission[];
          notOwned: string[];
        }>("GET", `${BASE}/plan`);
        if (json) {
          printJson(res);
          return;
        }
        for (const s of res.helpers) process.stdout.write(`${s};\n`);
        for (const s of res.enables) process.stdout.write(`${s};\n`);
        for (const p of res.policies) {
          for (const s of p.statements) process.stdout.write(`${s};\n`);
        }
        printOmissions(res.omissions);
        return;
      }
      case "apply": {
        const res = await client.request<{
          applied: number;
          tables: string[];
          statements: number;
          omissions: Omission[];
        }>("POST", `${BASE}/apply`, {});
        if (json) {
          printJson(res);
          return;
        }
        process.stdout.write(
          `${res.applied} policies across ${res.tables.length} tables (${res.statements} statements).\n`,
        );
        printOmissions(res.omissions);
        return;
      }
      case "disable": {
        const res = await client.request<{ dropped: number; disabled: string[] }>(
          "POST",
          `${BASE}/disable`,
          {},
        );
        if (json) {
          printJson(res);
          return;
        }
        process.stdout.write(
          `dropped ${res.dropped} policies; row security disabled on ${res.disabled.length} table(s).\n`,
        );
        if (res.dropped > 0 && res.disabled.length === 0) {
          // Worth saying out loud: the tables still have row security ON,
          // because something else's policy is still there.
          process.stdout.write(
            "Every table still carries a policy from somewhere else, so row security stayed on.\n",
          );
        }
        return;
      }
      default:
        process.stdout.write(HELP);
    }
  } catch (e) {
    die(e, `rls ${sub}`);
  }
};
