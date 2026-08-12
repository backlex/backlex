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

interface ListingCategoryRow {
  id: string;
  name: string;
  parentId: string | null;
  leaf: boolean;
}

interface ListingAttributeRow {
  id: string;
  name: string;
  required: boolean;
  variant: boolean;
  values: { id: string; name: string }[];
}

interface ListingMapRow {
  id: string;
  localValue: string;
  categoryId: string;
  attributes: Record<string, Record<string, string>>;
}

interface ListingBatchRow {
  batchId: string;
  status: string;
  unitCount: number;
  pendingCount: number;
  error: string | null;
}

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

const INTEGRATIONS_HELP = `backlex integrations <catalog|list|connect|authorize|syncs|hooks|deliveries|resume|disconnect>

  catalog                              providers available to connect
  catalog <kind>                       the config fields one provider needs
  list                                 connected integrations + health
  connect --kind <k> --set k=v [...]   connect or reconfigure a provider
         [--events a,b]                scope which events reach it (default all)
  connect --kind <k> --data <json|@file|->
  authorize <id>                       print the OAuth link to open in a browser
  syncs [--integration <id>]           scheduled syncs + health
  sync-create --integration <id> --collection <slug>
              [--direction pull|push|inbound]
                                       rows in (default), collection out, or
                                       inbound — nothing to poll, the provider
                                       calls us
              [--match <field>]        inbound: the column a delivery is
                                       matched on (carrier tracking events)
              --set k=v [...]          provider settings (see catalog)
              --map External=field [...]
                                       push: --map field=DestinationColumn
              [--children <json|@file|->]
                                       pull only: where child rows land, keyed
                                       by provider group — see docs
              [--every <minutes>]      0 = manual only, default 60
  sync-run <id>                        run now and report what landed
  task-run <integration-id> <task> --collection <slug> --item <id>
              [--set k=v ...]          task settings (see catalog)
              [--out Output=field ...] where the task's outputs land
              [--force]                re-run one that already succeeded
  task-runs --collection <slug> --item <id>
                                       what was already done to a row
  sync-update <id> [--every N] [--enable|--disable] [--match <field>]
  sync-delete <id>
  hook-on <sync-id> [--events a,b]     turn the inbound endpoint on; prints the
                                       URL and the secret ONCE, and registers it
                                       at the provider where that is possible
  hook-events <sync-id> --events a,b   change what the endpoint accepts
  hook-off <sync-id>                   tear the endpoint down
  hooks <sync-id>                      what the provider delivered, newest first
  categories <integration-id>          the marketplace's category tree, flattened
  attributes <integration-id> --category <id>
                                       what that leaf category demands
  brands <integration-id> --q <text>   search a registry the provider declares
  maps <sync-id>                       how local categories are mapped
  map <sync-id> --value <local> --category <id> [--attr 92=valueId:10633877]
                                       map one local category, or re-map it
  unmap <sync-id> <map-id>             remove one mapping
  batches <sync-id>                    what was published, and what is pending
  deliveries <id> [--limit N]          recent attempts, newest first
  resume <id>                          re-enable a breaker-paused integration
  disconnect <id>

An endpoint's secret is shown by \`hook-on\` and never again — it is a bearer
credential the provider also holds. Lost means run \`hook-on\` again, which keeps
the same URL and mints a new secret.

Providers marked oauth=yes in the catalog are connected by redirect, not by a
pasted key: save clientId + clientSecret with \`connect\`, then open the link
\`authorize\` prints. The link is single-use, expires in 10 minutes, and only
completes in a browser already signed in as the same admin.
`;

const BASE = "/api/admin/integrations";

/**
 * The directions a sync may travel.
 *
 * Kept here rather than imported: the CLI talks to a REMOTE instance over HTTP
 * and must not depend on the server package. It is checked before the request
 * so a typo names the flag instead of falling through to the default and
 * creating a PULL — which then fails on its first run with an error about the
 * wrong half of the provider.
 */
const DIRECTIONS = ["pull", "push", "inbound", "listing"];

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
        if (direction !== undefined && !DIRECTIONS.includes(direction)) {
          process.stderr.write(`--direction must be one of: ${DIRECTIONS.join(", ")}\n`);
          process.exit(1);
        }
        const matchField = flag(args, "--match");
        // Listing only. Both are required for that direction and refused for
        // every other, which the server says plainly — repeated here would be a
        // second rule to keep in step.
        const categoryField = flag(args, "--category-field");
        const outputsMapping = collectSet(args, "--out");
        // JSON rather than a repeated flag: a child group is four values deep
        // (group, collection, parent column, field map) and every flag syntax
        // that flattens it turns into a punctuation puzzle at the shell.
        const childrenFlag = flag(args, "--children");
        const childMappings = childrenFlag
          ? (JSON.parse(await resolvePayload(childrenFlag)) as Record<string, unknown>)
          : undefined;
        const { data } = await client.request<{ data: SyncRow }>("POST", `${BASE}/syncs`, {
          integrationId,
          collection,
          ...(direction === undefined ? {} : { direction }),
          settings: collectSet(args),
          mapping,
          ...(childMappings === undefined ? {} : { childMappings }),
          ...(every === undefined ? {} : { intervalMinutes: Number(every) }),
          ...(matchField === undefined ? {} : { matchField }),
          ...(categoryField === undefined ? {} : { categoryField }),
          ...(outputsMapping === undefined ? {} : { outputsMapping }),
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
      case "categories": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("categories needs an integration id\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: ListingCategoryRow[] }>(
          "GET",
          `${BASE}/${encodeURIComponent(id)}/listing/categories`,
        );
        if (json) printJson(data);
        else {
          // Only leaves are listable, and a tree of a few thousand nodes is
          // unreadable at a terminal — so the default is the sellable ones.
          const leaves = data.filter((c) => c.leaf);
          printTable(leaves.map((c) => ({ id: c.id, name: c.name, parent: c.parentId ?? "" })));
          process.stdout.write(`\n${leaves.length} leaf of ${data.length} categories\n`);
        }
        return;
      }
      case "attributes": {
        const id = rest[0];
        const categoryId = flag(args, "--category");
        if (!id || !categoryId) {
          process.stderr.write("attributes needs an integration id and --category <id>\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: ListingAttributeRow[] }>(
          "GET",
          `${BASE}/${encodeURIComponent(id)}/listing/attributes?categoryId=${encodeURIComponent(categoryId)}`,
        );
        if (json) printJson(data);
        else
          printTable(data.map((a) => ({
              id: a.id,
              name: a.name,
              // The three flags that decide how a value is supplied at all.
              required: a.required ? "yes" : "",
              variant: a.variant ? "yes" : "",
              values: a.values.length ? String(a.values.length) : "free text",
            })));
        return;
      }
      case "brands": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("brands needs an integration id\n");
          process.exit(1);
        }
        const qs = new URLSearchParams({ lookup: flag(args, "--lookup") ?? "brands" });
        const q = flag(args, "--q");
        if (q) qs.set("query", q);
        const { data } = await client.request<{ data: { items: { id: string; name: string }[] } }>(
          "GET",
          `${BASE}/${encodeURIComponent(id)}/listing/lookup?${qs}`,
        );
        if (json) printJson(data);
        else printTable(data.items);
        return;
      }
      case "maps": {
        const syncId = rest[0];
        if (!syncId) {
          process.stderr.write("maps needs a sync id\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: ListingMapRow[] }>(
          "GET",
          `${BASE}/syncs/${encodeURIComponent(syncId)}/listing/maps`,
        );
        if (json) printJson(data);
        else
          printTable(
            data.map((m) => ({
              id: m.id,
              local: m.localValue,
              category: m.categoryId,
              attrs: String(Object.keys(m.attributes ?? {}).length),
            })));
        return;
      }
      case "map": {
        const syncId = rest[0];
        const localValue = flag(args, "--value");
        const categoryId = flag(args, "--category");
        if (!syncId || !localValue || !categoryId) {
          process.stderr.write("map needs a sync id, --value <local> and --category <id>\n");
          process.exit(1);
        }
        // `--attr 92=valueId:10633877` / `=custom:Kırmızı` / `=field:size`.
        // One flag with a named half rather than three flags, because which of
        // the three an attribute takes is decided by the attribute, not the
        // operator, and three flags invites sending two.
        const attributes: Record<string, Record<string, string>> = {};
        for (const [attributeId, raw] of Object.entries(collectSet(args, "--attr"))) {
          const split = raw.indexOf(":");
          const kind = split < 0 ? "" : raw.slice(0, split);
          const value = split < 0 ? "" : raw.slice(split + 1);
          if (!["valueId", "custom", "field"].includes(kind) || !value) {
            process.stderr.write(
              `--attr ${attributeId} must be valueId:<id>, custom:<text> or field:<column>\n`,
            );
            process.exit(1);
          }
          attributes[attributeId] = { [kind]: value };
        }
        const { data } = await client.request<{ data: ListingMapRow }>(
          "PUT",
          `${BASE}/syncs/${encodeURIComponent(syncId)}/listing/maps`,
          { localValue, categoryId, attributes },
        );
        if (json) printJson(data);
        else printKeyValues({ id: data.id, local: data.localValue, category: data.categoryId });
        return;
      }
      case "unmap": {
        const syncId = rest[0];
        const mapId = rest[1];
        if (!syncId || !mapId) {
          process.stderr.write("unmap needs a sync id and a map id\n");
          process.exit(1);
        }
        await client.request(
          "DELETE",
          `${BASE}/syncs/${encodeURIComponent(syncId)}/listing/maps/${encodeURIComponent(mapId)}`,
        );
        if (json) printJson({ ok: true });
        else process.stdout.write("unmapped\n");
        return;
      }
      case "batches": {
        const syncId = rest[0];
        if (!syncId) {
          process.stderr.write("batches needs a sync id\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: ListingBatchRow[] }>(
          "GET",
          `${BASE}/syncs/${encodeURIComponent(syncId)}/listing/batches`,
        );
        if (json) printJson(data);
        else
          printTable(data.map((b) => ({
              batch: b.batchId,
              status: b.status,
              units: String(b.unitCount),
              // What an operator actually watches: a batch is not done until
              // the marketplace has ruled on every unit, which takes hours.
              pending: String(b.pendingCount),
              error: b.error ?? "",
            })));
        return;
      }
      case "task-run": {
        const integrationId = rest[0];
        const task = rest[1];
        const collection = flag(args, "--collection");
        const itemId = flag(args, "--item");
        if (!integrationId || !task || integrationId.startsWith("--") || !collection || !itemId) {
          process.stderr.write(
            "Usage: backlex integrations task-run <integration-id> <task> --collection <slug> --item <id>\n",
          );
          process.exit(1);
        }
        const { data } = await client.request<{
          data: { status: string; outputs: Record<string, unknown>; artifactKey: string | null; reused: boolean };
        }>("POST", `${BASE}/${encodeURIComponent(integrationId)}/tasks/${encodeURIComponent(task)}`, {
          collection,
          itemId,
          settings: collectSet(args),
          outputMapping: collectSet(args, "--out"),
          ...(args.includes("--force") ? { force: true } : {}),
        });
        if (json) printJson(data);
        else
          printKeyValues({
            status: data.status,
            // Says plainly that nothing was called, which is the whole point of
            // the guard — an operator seeing "succeeded" twice would assume two
            // shipments exist.
            reused: data.reused ? "yes (previous run's result)" : "no",
            ...data.outputs,
            ...(data.artifactKey ? { artifact: data.artifactKey } : {}),
          });
        return;
      }
      case "task-runs": {
        const collection = flag(args, "--collection");
        const itemId = flag(args, "--item");
        if (!collection || !itemId) {
          process.stderr.write("Usage: backlex integrations task-runs --collection <slug> --item <id>\n");
          process.exit(1);
        }
        const { data } = await client.request<{
          data: { task: string; status: string; attempts: number; error?: string | null }[];
        }>(
          "GET",
          `${BASE}/task-runs?collection=${encodeURIComponent(collection)}&itemId=${encodeURIComponent(itemId)}`,
        );
        if (json) printJson(data);
        else
          printTable(
            data.map((r) => ({
              task: r.task,
              status: r.status,
              attempts: String(r.attempts),
              error: r.error ?? "",
            })),
          );
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
        const nextMatch = flag(args, "--match");
        if (nextMatch !== undefined) patch.matchField = nextMatch;
        if (Object.keys(patch).length === 0) {
          process.stderr.write("Nothing to change — pass --every, --enable, --disable or --match\n");
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
      case "hook-on": {
        const id = rest[0];
        if (!id || id.startsWith("--")) {
          process.stderr.write("Usage: backlex integrations hook-on <sync-id> [--events a,b]\n");
          process.exit(1);
        }
        const events = csv(flag(rest, "--events"));
        const { data } = await client.request<{
          data: {
            url: string;
            secret: string | null;
            events: string[];
            registered: boolean;
            registrationError?: string;
          };
        }>("POST", `${BASE}/syncs/${encodeURIComponent(id)}/webhook`, {
          ...(events.length === 0 ? {} : { events }),
        });
        if (json) printJson(data);
        else {
          printKeyValues({
            url: data.url,
            secret: data.secret ?? "(not returned)",
            events: data.events.length === 0 ? "all" : data.events.join(","),
            registered: data.registered ? "yes" : "no",
          });
          // Said out loud rather than left to the docs: the secret is on screen
          // exactly once, and the next command that prints this row will not
          // have it.
          process.stdout.write(
            "\nThe secret is shown once. Save it now — nothing reads it back.\n",
          );
          if (data.registrationError) {
            process.stdout.write(
              `\nThe endpoint is live but ${data.registrationError}\n` +
                "Run hook-on again to retry, or point the provider at the URL by hand.\n",
            );
          } else if (!data.registered) {
            process.stdout.write("\nGive the URL and secret to the provider — it cannot be registered from here.\n");
          }
        }
        return;
      }
      case "hook-events": {
        const id = rest[0];
        const events = flag(rest, "--events");
        if (!id || id.startsWith("--") || events === undefined) {
          process.stderr.write("Usage: backlex integrations hook-events <sync-id> --events a,b\n");
          process.exit(1);
        }
        const { data } = await client.request<{ data: SyncRow }>(
          "PATCH",
          `${BASE}/syncs/${encodeURIComponent(id)}/webhook`,
          { events: csv(events) },
        );
        if (json) printJson(data);
        else printKeyValues({ id: data.id, events: csv(events).join(",") || "all" });
        return;
      }
      case "hook-off": {
        const id = rest[0];
        if (!id || id.startsWith("--")) {
          process.stderr.write("Usage: backlex integrations hook-off <sync-id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/syncs/${encodeURIComponent(id)}/webhook`);
        process.stdout.write("Endpoint removed. The sync and every row it wrote stay.\n");
        return;
      }
      case "hooks": {
        const id = rest[0];
        if (!id || id.startsWith("--")) {
          process.stderr.write("Usage: backlex integrations hooks <sync-id>\n");
          process.exit(1);
        }
        const { data } = await client.request<{
          data: { event: string; status: string; rowsWritten: number; error: string | null }[];
        }>("GET", `${BASE}/syncs/${encodeURIComponent(id)}/deliveries`);
        if (json) printJson(data);
        else
          printTable(
            data.map((d) => ({
              event: d.event,
              // The verdict is the column an operator came for: "applied" and
              // "unmatched" look the same from the provider's side and mean
              // completely different things here.
              status: d.status,
              rows: d.rowsWritten,
              error: d.error ?? "",
            })),
          );
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
