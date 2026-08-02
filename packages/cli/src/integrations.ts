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

interface SyncRow {
  id: string;
  integrationId: string;
  collection: string;
  /** `pull` brings rows in; `push` mirrors the collection out. */
  direction?: string;
  intervalMinutes: number;
  enabled: boolean;
  resuming: boolean;
  lastRunAt?: number | string | null;
  lastRowCount: number;
  lastError?: string | null;
  disabledReason?: string | null;
}

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
  fields: { key: string; label: string; secret?: boolean; options?: { value: string }[] }[];
  oauth?: boolean;
}

const INTEGRATIONS_HELP = `backlex integrations <catalog|list|connect|authorize|syncs|deliveries|resume|disconnect>

  catalog                              providers available to connect
  catalog <kind>                       the config fields one provider needs
  list                                 connected integrations + health
  connect --kind <k> --set k=v [...]   connect or reconfigure a provider
         [--events a,b]                scope which events reach it (default all)
  connect --kind <k> --data <json|@file|->
  authorize <id>                       print the OAuth link to open in a browser
  syncs [--integration <id>]           scheduled syncs + health
  sync-create --integration <id> --collection <slug>
              [--direction pull|push]  rows in (default) or collection out
              --set k=v [...]          provider settings (see catalog)
              --map External=field [...]
                                       push: --map field=DestinationColumn
              [--every <minutes>]      0 = manual only, default 60
  sync-run <id>                        run now and report what landed
  sync-update <id> [--every N] [--enable|--disable]
  sync-delete <id>
  deliveries <id> [--limit N]          recent attempts, newest first
  resume <id>                          re-enable a breaker-paused integration
  disconnect <id>

Providers marked oauth=yes in the catalog are connected by redirect, not by a
pasted key: save clientId + clientSecret with \`connect\`, then open the link
\`authorize\` prints. The link is single-use, expires in 10 minutes, and only
completes in a browser already signed in as the same admin.
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
const collectSet = (args: string[], flagName = "--set"): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flagName) continue;
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
        const { data } = await client.request<{
          data: { providers: ProviderRow[]; oauthRedirectUri?: string };
        }>("GET", `${BASE}/catalog`);
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
              p.fields.map((f) => ({
                key: f.key,
                label: f.label,
                secret: f.secret ? "yes" : "",
                // A closed set — printing it saves a round trip through a 422.
                values: f.options ? f.options.map((o) => o.value).join(" | ") : "",
              })),
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
              oauth: p.oauth ? "yes" : "",
            })),
          );
        if (!json && data.oauthRedirectUri && providers.some((p) => p.oauth)) {
          // Whoever registers the OAuth app needs this exact string, and
          // guessing it from the browser's origin gets it wrong behind a proxy.
          process.stdout.write(`\nOAuth redirect URI to register: ${data.oauthRedirectUri}\n`);
        }
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
      case "authorize": {
        const id = rest[0];
        if (!id || id.startsWith("--")) {
          process.stderr.write("Usage: backlex integrations authorize <id>\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: { url: string } }>(
          "POST",
          `${BASE}/${encodeURIComponent(id)}/oauth/authorize`,
        );
        if (json) printJson(data);
        else {
          // Printed rather than opened: the CLI may be on a server with no
          // browser, and the flow has to finish in the admin's own session.
          process.stdout.write(`Open this in a browser signed in as this admin:\n\n${data.url}\n`);
        }
        return;
      }
      case "syncs": {
        const only = flag(args, "--integration");
        const qs = only ? `?integrationId=${encodeURIComponent(only)}` : "";
        const { data } = await client.request<{ data: SyncRow[] }>("GET", `${BASE}/syncs${qs}`);
        if (json) printJson(data);
        else
          printTable(
            data.map((sc) => ({
              id: sc.id,
              collection: sc.collection,
              // Drawn in the direction of travel, so a glance says which way the
              // rows are moving rather than which provider is involved.
              direction: sc.direction === "push" ? "out" : "in",
              every: sc.intervalMinutes === 0 ? "manual" : `${sc.intervalMinutes}m`,
              state: sc.enabled ? (sc.resuming ? "resuming" : "on") : "paused",
              rows: sc.lastRowCount,
              // The reason a sync is paused matters more than the fact of it.
              error: sc.disabledReason ?? sc.lastError ?? "",
            })),
          );
        return;
      }
      case "sync-create": {
        const integrationId = flag(args, "--integration");
        const collection = flag(args, "--collection");
        if (!integrationId || !collection) {
          process.stderr.write("sync-create needs --integration <id> and --collection <slug>\n");
          process.exit(1);
        }
        const mapping = collectSet(args, "--map");
        if (Object.keys(mapping).length === 0) {
          // The server rejects an empty mapping too, but saying so here saves a
          // round trip and names the flag.
          process.stderr.write("sync-create needs at least one --map External=field\n");
          process.exit(1);
        }
        const every = flag(args, "--every");
        // Checked here rather than left to the server: a typo'd direction would
        // otherwise fall through to the default and create a PULL, which fails
        // on its first run with an error about the wrong half of the provider.
        const direction = flag(args, "--direction");
        if (direction !== undefined && direction !== "pull" && direction !== "push") {
          process.stderr.write("--direction must be pull or push\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: SyncRow }>("POST", `${BASE}/syncs`, {
          integrationId,
          collection,
          ...(direction === undefined ? {} : { direction }),
          settings: collectSet(args),
          mapping,
          ...(every === undefined ? {} : { intervalMinutes: Number(every) }),
        });
        if (json) printJson(data);
        else
          printKeyValues({
            id: data.id,
            collection: data.collection,
            direction: data.direction ?? "pull",
            every: `${data.intervalMinutes}m`,
          });
        return;
      }
      case "sync-run": {
        const id = rest[0];
        if (!id || id.startsWith("--")) {
          process.stderr.write("Usage: backlex integrations sync-run <id>\n");
          process.exit(1);
        }
        const { data } = await client.request<{
          data: { written: number; pages: number; complete: boolean };
        }>("POST", `${BASE}/syncs/${encodeURIComponent(id)}/run`);
        if (json) printJson(data);
        else
          printKeyValues({
            rows: String(data.written),
            pages: String(data.pages),
            // `false` is not a failure — it means more pages are waiting.
            complete: data.complete ? "yes" : "no (resumes on the schedule)",
          });
        return;
      }
      case "sync-update": {
        const id = rest[0];
        if (!id || id.startsWith("--")) {
          process.stderr.write("Usage: backlex integrations sync-update <id> [--every N] [--enable|--disable]\n");
          process.exit(1);
        }
        const every = flag(args, "--every");
        const patch: Record<string, unknown> = {};
        if (every !== undefined) patch.intervalMinutes = Number(every);
        if (has(args, "--enable")) patch.enabled = true;
        if (has(args, "--disable")) patch.enabled = false;
        if (Object.keys(patch).length === 0) {
          process.stderr.write("Nothing to change — pass --every, --enable or --disable\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: SyncRow }>(
          "PATCH",
          `${BASE}/syncs/${encodeURIComponent(id)}`,
          patch,
        );
        if (json) printJson(data);
        else printKeyValues({ id: data.id, every: `${data.intervalMinutes}m`, enabled: String(data.enabled) });
        return;
      }
      case "sync-delete": {
        const id = rest[0];
        if (!id || id.startsWith("--")) {
          process.stderr.write("Usage: backlex integrations sync-delete <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/syncs/${encodeURIComponent(id)}`);
        process.stdout.write("Deleted. Rows already pulled stay in the collection.\n");
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
