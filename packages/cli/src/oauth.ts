/**
 * `backlex oauth` — the client registry for the authorization server this
 * instance already runs. See `docs/oauth-provider.md`.
 *
 * `grants` and `revoke` are the pair worth knowing: revoking removes the
 * consent AND every token issued under it, because removing only the consent
 * is a revocation that does not revoke.
 */
import { BacklexError } from "backlex";
import { flag, has, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

interface ClientRow {
  clientId: string;
  name: string;
  type: string;
  redirectUrls: string[];
  disabled: boolean;
  dynamic: boolean;
  activeTokens: number;
}

interface GrantRow {
  clientId: string;
  clientName: string;
  userId: string;
  scopes: string[];
  createdAt: number | null;
}

const HELP = `backlex oauth <clients|register|enable|disable|delete|grants|revoke>

  clients
  register --name <n> --redirect <url> [--redirect <url> …] [--confidential]
  enable <clientId>
  disable <clientId>
  delete <clientId>
  grants [--user <userId>] [--client <clientId>]
  revoke --client <clientId> --user <userId>

  A PUBLIC client (the default) gets no secret — PKCE protects it, and a secret
  shipped in a browser or a CLI is not a secret. --confidential issues one, and
  it is printed exactly once.

  Redirect URIs must be https, or http on loopback for a native app.

  \`disable\` stops a client immediately and keeps its history; \`delete\`
  cascades its tokens and consents away. For a client that misbehaved, disable
  it — the history is the evidence.

  \`revoke\` deletes the consent AND every token issued under it.

  Set OAUTH_DYNAMIC_REGISTRATION=off to close open registration, after which
  this registry is the only way a client gets in.
`;

const BASE = "/api/admin/oauth-clients";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

/** Every `--redirect <url>` on the line, not just the first. */
const allFlags = (args: string[], name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) out.push(args[i + 1]!);
  }
  return out;
};

export const runOAuth = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  const setDisabled = async (disabled: boolean) => {
    const id = rest[0];
    if (!id) {
      process.stderr.write(`oauth ${disabled ? "disable" : "enable"} <clientId>\n`);
      process.exit(1);
    }
    await client.request("PATCH", `${BASE}/${encodeURIComponent(id)}`, { disabled });
    process.stdout.write(disabled ? "disabled\n" : "enabled\n");
  };

  try {
    switch (sub) {
      case "clients": {
        const res = await client.request<{
          data: ClientRow[];
          dynamicRegistration: boolean;
        }>("GET", BASE);
        if (json) {
          printJson(res);
          return;
        }
        printTable(
          res.data.map((r) => ({
            "client id": r.clientId,
            name: r.name,
            type: r.type,
            origin: r.dynamic ? "self-registered" : "operator",
            tokens: String(r.activeTokens),
            status: r.disabled ? "disabled" : "on",
          })),
        );
        process.stdout.write(
          `\nopen dynamic registration: ${res.dynamicRegistration ? "ON" : "off"}\n`,
        );
        return;
      }
      case "register": {
        const name = flag(rest, "--name");
        const redirectUrls = allFlags(rest, "--redirect");
        if (!name || redirectUrls.length === 0) {
          process.stderr.write("oauth register --name <n> --redirect <url>\n");
          process.exit(1);
        }
        const res = await client.request<{
          data: ClientRow;
          clientSecret: string | null;
        }>("POST", BASE, {
          name,
          redirectUrls,
          type: has(rest, "--confidential") ? "confidential" : "public",
        });
        if (json) {
          printJson(res);
          return;
        }
        printKeyValues({
          "client id": res.data.clientId,
          type: res.data.type,
          ...(res.clientSecret ? { "client secret": res.clientSecret } : {}),
        });
        if (res.clientSecret) {
          process.stdout.write("\nThe secret is shown once. Store it now.\n");
        }
        return;
      }
      case "enable":
        await setDisabled(false);
        return;
      case "disable":
        await setDisabled(true);
        return;
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("oauth delete <clientId>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stdout.write("deleted\n");
        return;
      }
      case "grants": {
        const q = new URLSearchParams();
        const user = flag(rest, "--user");
        if (user) q.set("userId", user);
        const c = flag(rest, "--client");
        if (c) q.set("clientId", c);
        const qs = q.toString();
        const { data } = await client.request<{ data: GrantRow[] }>(
          "GET",
          `${BASE}/grants${qs ? `?${qs}` : ""}`,
        );
        if (json) printJson(data);
        else
          printTable(
            data.map((g) => ({
              client: g.clientName,
              "client id": g.clientId,
              user: g.userId,
              scopes: g.scopes.join(" "),
              when: g.createdAt ? new Date(g.createdAt).toISOString() : "—",
            })),
          );
        return;
      }
      case "revoke": {
        const clientId = flag(rest, "--client");
        const userId = flag(rest, "--user");
        if (!clientId || !userId) {
          process.stderr.write("oauth revoke --client <clientId> --user <userId>\n");
          process.exit(1);
        }
        const res = await client.request<{ tokensRevoked: number }>(
          "POST",
          `${BASE}/grants/revoke`,
          { clientId, userId },
        );
        process.stdout.write(
          `revoked — ${res.tokensRevoked} token(s) invalidated with the consent\n`,
        );
        return;
      }
      default:
        process.stdout.write(HELP);
    }
  } catch (e) {
    die(e, `oauth ${sub}`);
  }
};
