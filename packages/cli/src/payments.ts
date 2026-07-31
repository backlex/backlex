/**
 * `backlex payments` — connect payment providers and drive the sync over
 * `/api/admin/payments`. The synced business data is read with the ordinary
 * `backlex items payment_customers` etc. See `docs/payments.md`.
 */
import { BacklexError } from "backlex";
import {
  has,
  flag,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolveContext,
} from "./client";

interface ProviderRow {
  id: string;
  provider: string;
  status: string;
  webhookPath: string;
  lastEventAt?: unknown;
  lastSyncAt?: unknown;
  lastSyncError: string | null;
}

const PAYMENTS_HELP = `backlex payments <catalog|list|connect|checkout|sync|events|rotate-token|provision|disconnect>

  catalog                       supported providers + the config each one needs
  list                          connected providers (secrets masked)
  connect --provider <p> [--api-key <k>] [--webhook-secret <s>] [--store-id <id>]
          [--server <env>] [--set key=value ...]
                                connect a provider; --set carries any config key
                                (merchantId, merchantSalt, secretKey, environment …)
  checkout --amount <minor> --currency <cur> [--provider <p> | --provider-id <id>]
           [--description <t>] [--email <e>] [--name <n>] [--success-url <u>]
           [--cancel-url <u>] [--reference <r>] [--customer-ip <ip>]
           [--write-back <collection>:<itemId>:<urlField>[:<referenceField>]]
                                open a hosted checkout and print the payment link
  sync <id> [--kinds a,b] [--max-pages N] [--resume] [--async]
                                pull objects back from the provider API
  events [--provider <id>] [--limit N]
                                recent webhook deliveries
  rotate-token <id>             new receive URL (the old one stops working)
  provision                     (re-)create the four sync collections
  disconnect <id>               remove the connection (synced rows are kept)

  Amounts are MINOR units — 1050 is $10.50, matching payment_transactions.amount.
`;

const BASE = "/api/admin/payments";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const csv = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Repeatable `--set key=value`. The named flags below only ever covered the
 * three webhook providers' keys, so PayTR, iyzico and the dummy provider were
 * unreachable from the CLI even though the endpoint accepted them. Rather than
 * chase every provider's field names with a flag each, this passes any config
 * key straight through — `payments catalog` lists what a given provider wants.
 */
const collectSet = (args: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--set") continue;
    const pair = args[i + 1];
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
};

export const runPayments = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(PAYMENTS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "catalog": {
        const res = await client.request<{
          providers: { provider: string; label: string; fields: { key: string; secret?: boolean }[] }[];
        }>("GET", `${BASE}/catalog`);
        if (json) printJson(res);
        else
          printTable(
            res.providers.map((p) => ({
              provider: p.provider,
              label: p.label,
              config: p.fields.map((f) => (f.secret ? `${f.key}*` : f.key)).join(", "),
            })),
          );
        return;
      }
      case "list": {
        const res = await client.request<{ data: ProviderRow[]; stats: Record<string, number> }>(
          "GET",
          `${BASE}/providers`,
        );
        if (json) printJson(res);
        else {
          printTable(
            res.data.map((p) => ({
              id: p.id,
              provider: p.provider,
              status: p.status,
              webhook: p.webhookPath,
              lastSync: p.lastSyncError ? `error: ${p.lastSyncError}` : String(p.lastSyncAt ?? "—"),
            })),
          );
          if (Object.keys(res.stats).length > 0) printKeyValues(res.stats);
        }
        return;
      }
      case "connect": {
        const provider = flag(rest, "--provider");
        if (!provider) {
          process.stderr.write(
            "payments connect --provider <name> … (see `backlex payments catalog`)\n",
          );
          process.exit(1);
        }
        // Only the flags actually passed are sent: an omitted secret means
        // "keep the stored one", which is how a reconnect edits just the
        // store id without re-pasting the API key.
        const config: Record<string, string> = collectSet(rest);
        const apiKey = flag(rest, "--api-key");
        const webhookSecret = flag(rest, "--webhook-secret");
        const storeId = flag(rest, "--store-id");
        const server = flag(rest, "--server");
        if (apiKey) config.apiKey = apiKey;
        if (webhookSecret) config.webhookSecret = webhookSecret;
        if (storeId) config.storeId = storeId;
        if (server) config.server = server;

        const res = await client.request<{
          data: ProviderRow;
          collections: { created: string[]; existing: string[]; conflicts: string[] };
        }>("POST", `${BASE}/providers`, { provider, config });
        if (json) printJson(res);
        else {
          printKeyValues({
            id: res.data.id,
            provider: res.data.provider,
            status: res.data.status,
            webhookPath: res.data.webhookPath,
            collectionsCreated: res.data ? res.collections.created.join(", ") || "—" : "—",
          });
          process.stderr.write(
            `\nPaste the webhook path above (prefixed with your origin) into the ${provider} dashboard.\n`,
          );
          if (res.collections.conflicts.length > 0) {
            process.stderr.write(
              `\nWARNING: ${res.collections.conflicts.join(", ")} already exist and are NOT ` +
                `payments sync targets. Nothing will be written to them until they're renamed.\n`,
            );
          }
        }
        return;
      }
      case "checkout": {
        const amount = flag(rest, "--amount");
        const currency = flag(rest, "--currency");
        if (!amount || !currency) {
          process.stderr.write(
            "payments checkout --amount <minor units> --currency <ISO-4217> …\n",
          );
          process.exit(1);
        }
        const body: Record<string, unknown> = {
          amount: Number(amount),
          currency,
        };
        const provider = flag(rest, "--provider");
        const providerId = flag(rest, "--provider-id");
        const description = flag(rest, "--description");
        const successUrl = flag(rest, "--success-url");
        const cancelUrl = flag(rest, "--cancel-url");
        const reference = flag(rest, "--reference");
        const customerIp = flag(rest, "--customer-ip");
        const email = flag(rest, "--email");
        const name = flag(rest, "--name");
        if (provider) body.provider = provider;
        if (providerId) body.providerId = providerId;
        if (description) body.description = description;
        if (successUrl) body.successUrl = successUrl;
        if (cancelUrl) body.cancelUrl = cancelUrl;
        if (reference) body.reference = reference;
        if (customerIp) body.customerIp = customerIp;
        if (email || name) body.customer = { ...(email ? { email } : {}), ...(name ? { name } : {}) };

        // `collection:itemId:urlField[:referenceField]` — one flag rather than
        // four, because all of them are required together or not at all.
        const writeBack = flag(rest, "--write-back");
        if (writeBack) {
          const [collection, itemId, urlField, referenceField] = writeBack.split(":");
          if (!collection || !itemId || !urlField) {
            process.stderr.write(
              "--write-back needs <collection>:<itemId>:<urlField>[:<referenceField>]\n",
            );
            process.exit(1);
          }
          body.writeBack = {
            collection,
            itemId,
            urlField,
            ...(referenceField ? { referenceField } : {}),
          };
        }

        const res = await client.request<{ data: Record<string, unknown> }>(
          "POST",
          `${BASE}/checkout`,
          body,
        );
        if (json) printJson(res.data);
        else {
          printKeyValues({
            provider: res.data.provider as string,
            url: res.data.url as string,
            reference: res.data.reference as string,
            expiresAt: String(res.data.expiresAt ?? "—"),
          });
          if (res.data.writtenBack) {
            const w = res.data.writtenBack as { collection: string; itemId: string; fields: string[] };
            process.stderr.write(
              `\nWrote ${w.fields.join(", ")} onto ${w.collection}/${w.itemId}.\n`,
            );
          }
        }
        return;
      }
      case "sync": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("payments sync <id> [--kinds a,b] [--async]\n");
          process.exit(1);
        }
        const kinds = csv(flag(rest, "--kinds"));
        const maxPages = flag(rest, "--max-pages");
        const body: Record<string, unknown> = {};
        if (kinds.length > 0) body.kinds = kinds;
        if (maxPages) body.maxPages = Number(maxPages);
        if (has(rest, "--resume")) body.resume = true;
        if (has(rest, "--async")) body.async = true;
        const res = await client.request<Record<string, unknown>>(
          "POST",
          `${BASE}/providers/${encodeURIComponent(id)}/sync`,
          body,
        );
        if (json) printJson(res);
        else printKeyValues(res as Record<string, unknown>);
        return;
      }
      case "events": {
        const qs = new URLSearchParams();
        const providerId = flag(rest, "--provider");
        const limit = flag(rest, "--limit");
        if (providerId) qs.set("providerId", providerId);
        if (limit) qs.set("limit", String(Number(limit)));
        const q = qs.toString();
        const { data } = await client.request<{ data: Record<string, unknown>[] }>(
          "GET",
          `${BASE}/events${q ? `?${q}` : ""}`,
        );
        if (json) printJson(data);
        else
          printTable(
            data.map((e) => ({
              type: e.type,
              status: e.status,
              rows: e.recordCount,
              eventId: e.externalId,
              error: e.error ?? "",
            })),
          );
        return;
      }
      case "rotate-token": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("payments rotate-token <id>\n");
          process.exit(1);
        }
        const res = await client.request<{ data: ProviderRow }>(
          "POST",
          `${BASE}/providers/${encodeURIComponent(id)}/rotate-token`,
        );
        if (json) printJson(res.data);
        else {
          printKeyValues({ id: res.data.id, webhookPath: res.data.webhookPath });
          process.stderr.write("\nThe previous URL no longer accepts deliveries — update the provider.\n");
        }
        return;
      }
      case "provision": {
        const res = await client.request<{
          created: string[];
          existing: string[];
          conflicts: string[];
        }>("POST", `${BASE}/collections`);
        if (json) printJson(res);
        else
          printKeyValues({
            created: res.created.join(", ") || "—",
            existing: res.existing.join(", ") || "—",
            conflicts: res.conflicts.join(", ") || "—",
          });
        return;
      }
      case "disconnect": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("payments disconnect <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/providers/${encodeURIComponent(id)}`);
        process.stderr.write(`Disconnected provider ${id}. Synced rows were kept.\n`);
        return;
      }
      default:
        process.stderr.write(`unknown payments subcommand: ${sub}\n\n${PAYMENTS_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `payments ${sub}`);
  }
};
