/**
 * `backlex signing-keys` — JWT signing keys with a life cycle, so rotation is a
 * state change rather than two deploys. See `docs/signing-keys.md`.
 *
 * The order is the feature: generate → let the JWKS propagate → promote.
 * A key that started signing the moment it existed would mint tokens nobody
 * could verify until their JWKS cache expired.
 */
import { BacklexError } from "backlex";
import { flag, has, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

interface KeyRow {
  id: string;
  kid: string;
  alg: string;
  status: string;
  note: string | null;
  published: boolean;
  activatedAt: number | null;
}

const HELP = `backlex signing-keys <list|generate|import|promote|revoke|restore|delete>

  list
  generate [--alg ES256|RS256] [--note "<why>"]
  import --file <path-to-pkcs8.pem> [--note "<why>"]
  promote <id>
  revoke <id>
  restore <id>
  delete <id>

  States, and what each one does to a token:

    standby          published in the JWKS, signs nothing. A verifier caches
                     the JWKS, so a key must be VISIBLE before it signs.
    in_use           exactly one; new tokens carry its kid.
    previously_used  no longer signs, still verifies — its tokens are live.
    revoked          out of the JWKS; its tokens stop verifying.

  Rotation: generate, wait for verifiers to pick up the JWKS, promote.
  Rollback: promote the previous key again. Every transition is reversible.

  \`import\` takes the PEM currently in AUTH_JWT_PRIVATE_KEY, which is how a
  deployment moves off environment variables without invalidating live tokens.
`;

const BASE = "/api/admin/signing-keys";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

export const runSigningKeys = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  const act = async (verb: string) => {
    const id = rest[0];
    if (!id) {
      process.stderr.write(`signing-keys ${verb} <id>\n`);
      process.exit(1);
    }
    const res = await client.request<{ data: KeyRow }>(
      "POST",
      `${BASE}/${encodeURIComponent(id)}/${verb}`,
      {},
    );
    if (json) printJson(res.data);
    else printKeyValues({ kid: res.data.kid, status: res.data.status });
  };

  try {
    switch (sub) {
      case "list": {
        const { data } = await client.request<{ data: KeyRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((k) => ({
              id: k.id,
              kid: `${k.kid.slice(0, 12)}…`,
              alg: k.alg,
              status: k.status,
              "in jwks": k.published ? "yes" : "no",
              note: k.note ?? "",
            })),
          );
        return;
      }
      case "generate": {
        const body: Record<string, unknown> = {};
        const alg = flag(rest, "--alg");
        if (alg) body.alg = alg;
        const note = flag(rest, "--note");
        if (note) body.note = note;
        const res = await client.request<{ data: KeyRow }>("POST", BASE, body);
        if (json) {
          printJson(res.data);
          return;
        }
        printKeyValues({ id: res.data.id, kid: res.data.kid, alg: res.data.alg, status: res.data.status });
        process.stdout.write(
          "\nIt is published in the JWKS and signing nothing. Give verifiers time to\n" +
            `pick it up, then: backlex signing-keys promote ${res.data.id}\n`,
        );
        return;
      }
      case "import": {
        const file = flag(rest, "--file");
        if (!file) {
          process.stderr.write("signing-keys import --file <path-to-pkcs8.pem>\n");
          process.exit(1);
        }
        const { readFileSync } = await import("node:fs");
        const privateKey = readFileSync(file, "utf8");
        const body: Record<string, unknown> = { privateKey };
        const note = flag(rest, "--note");
        if (note) body.note = note;
        const res = await client.request<{ data: KeyRow }>("POST", `${BASE}/import`, body);
        if (json) printJson(res.data);
        else printKeyValues({ id: res.data.id, kid: res.data.kid, status: res.data.status });
        return;
      }
      case "promote":
      case "revoke":
      case "restore":
        await act(sub);
        return;
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("signing-keys delete <id>\n");
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
    die(e, `signing-keys ${sub}`);
  }
};
