import type { FetchLike } from "@backlex/integrations";
import type { Env } from "../env";
import { fetchOutbound } from "./storage/hosts";

/**
 * The `FetchLike` every call into `@backlex/integrations` should carry.
 *
 * The engine's own fallback is `((i, init) => fetch(i, init))` — the bare global
 * — and `fetchImpl` was only ever supplied by tests, so in production every
 * provider reached its base URL with no guard at all. That base URL is
 * TENANT-SUPPLIED for a whole class of them: `POST /api/admin/integrations`
 * takes `config` as `z.record(z.string(), z.unknown())`, so
 * `{kind:"clickhouse", config:{url:"http://10.0.0.7:9200/"}}` is an accepted
 * connection, and the destination's reply used to come back through the sync
 * row's `lastError`. A full-read SSRF primitive driven from the admin UI, live
 * even on managed cloud where the guard is supposed to be armed.
 *
 * Routing through `fetchOutbound` puts those calls under the same policy as
 * webhooks and flow `request` ops: the full private-host block where the
 * operator armed it, and the unconditional cloud-metadata refusal everywhere.
 *
 * Callers still accept an explicit `fetchImpl` — it is the specs' seam, and in
 * `dispatchIntegrations` its PRESENCE also selects inline delivery over the
 * durable queue. So this is applied at the leaf that actually calls a provider,
 * never as a default on the argument, or every dispatch would silently stop
 * being queued.
 */
export const guardedIntegrationFetch = (
  env: Pick<Env, "BLOCK_PRIVATE_FETCH_HOSTS" | "CLOUD_PROJECT_ID">,
): FetchLike => (input, init) => fetchOutbound(env, String(input), init);
