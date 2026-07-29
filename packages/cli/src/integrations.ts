/**
 * `backlex integrations` — connect third-party providers and inspect delivery
 * health over `/api/admin/integrations`. `resume` re-enables an integration the
 * auto-disable circuit breaker turned off (15 consecutive failed deliveries).
 * See `docs/integrations.md`.
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

interface IntegrationRow {
  id: string;
  kind: string;
  status: string;
  events: string[] | null;
  lastEventAt?: number | string | null;
  consecutiveFailures?: number;
  disabledReason?: string | null;
}

interface ProviderRow {
  id: string;
  label: string;
  category: string;
  capabilities: string[];
  fields: { key: string; label: string; secret?: boolean }[];
}

const INTEGRATIONS_HELP = `backlex integrations <catalog|list|connect|deliveries|resume|disconnect>

  catalog                              providers available to connect
  catalog <kind>                       the config fields one provider needs
  list                                 connected integrations + health
  connect --kind <k> --set k=v [...]   connect or reconfigure a provider
         [--events a,b]                scope which events reach it (default all)
  connect --kind <k> --data <json|@file|->
  deliveries <id> [--limit N]          recent attempts, newest first
  resume <id>                          re-enable a breaker-paused integration
  disconnect <id>
`;

const BASE = "/api/admin/integrations";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const csv = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Collect repeated `--set key=value` pairs into a config object. */
const collectSet = (args: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--set") continue;
    const pair = args[i + 1];
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
};

export const runIntegrations = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(INTEGRATIONS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "catalog": {
        const { data } = await client.request<{ data: { providers: ProviderRow[] } }>(
          "GET",
          `${BASE}/catalog`,
        );
        const providers = data.providers ?? [];
        const only = rest[0] && !rest[0].startsWith("--") ? rest[0] : null;
        if (only) {
          const p = providers.find((x) => x.id === only);
          if (!p) {
            process.stderr.write(`Unknown provider: ${only}\n`);
            process.exit(1);
          }
          if (json) printJson(p);
          else
            printTable(
              p.fields.map((f) => ({ key: f.key, label: f.label, secret: f.secret ? "yes" : "" })),
            );
          return;
        }
        if (json) printJson(providers);
        else
          printTable(
            providers.map((p) => ({
              id: p.id,
              label: p.label,
              category: p.category,
              capabilities: p.capabilities.join(", "),
            })),
          );
        return;
      }
      case "list": {
        const { data } = await client.request<{ data: IntegrationRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((i) => ({
              id: i.id,
              kind: i.kind,
              status:
                i.status === "connected"
                  ? i.consecutiveFailures
                    ? `connected (${i.consecutiveFailures} failing)`
                    : "connected"
                  : `${i.status} (${i.disabledReason ?? "manual"})`,
              events: i.events?.join(", ") ?? "all",
            })),
          );
        return;
      }
      case "connect": {
        const kind = flag(rest, "--kind");
        if (!kind) {
          process.stderr.write("integrations connect --kind <k> --set key=value\n");
          process.exit(1);
        }
        const dataFlag = flag(rest, "--data");
        const config = dataFlag
          ? (JSON.parse(await resolvePayload(dataFlag)) as Record<string, unknown>)
          : collectSet(rest);
        const events = csv(flag(rest, "--events"));
        const res = await client.request<{ data: IntegrationRow }>("POST", BASE, {
          kind,
          config,
          events: events.length ? events : null,
        });
        if (json) printJson(res.data);
        else printKeyValues({ id: res.data.id, kind: res.data.kind, status: res.data.status });
        return;
      }
      case "deliveries": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("integrations deliveries <id> [--limit N]\n");
          process.exit(1);
        }
        const limit = flag(rest, "--limit");
        const path = `${BASE}/${encodeURIComponent(id)}/deliveries${limit ? `?limit=${Number(limit)}` : ""}`;
        const { data } = await client.request<{ data: Record<string, unknown>[] }>("GET", path);
        if (json) printJson(data);
        else printTable(data);
        return;
      }
      case "resume": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("integrations resume <id>\n");
          process.exit(1);
        }
        await client.request("POST", `${BASE}/${encodeURIComponent(id)}/resume`);
        process.stderr.write(`Resumed integration ${id}.\n`);
        return;
      }
      case "disconnect": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("integrations disconnect <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(id)}`);
        process.stderr.write(`Disconnected integration ${id}.\n`);
        return;
      }
      default:
        process.stderr.write(INTEGRATIONS_HELP);
        process.exit(1);
    }
  } catch (e) {
    die(e, `integrations ${sub}`);
  }
};
