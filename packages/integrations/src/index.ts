/**
 * @backlex/integrations — runtime-agnostic third-party integration adapters.
 *
 * The single source of truth for connecting an org/workspace to Slack, Discord,
 * Datadog, or GitHub and fanning events out to it. Pure + dependency-free
 * (Workers + Node): no DB, no crypto, no env coupling. The CONSUMER owns:
 *   - persistence (the `integrations` row + its `config`),
 *   - secret encryption at rest (encrypt the SECRET_KEYS before store, decrypt
 *     before `deliverToIntegration`) and masking on read (`maskConfig`),
 *   - the event source (data events in the project admin; ops events in cloud).
 *
 * This lets the cloud control plane and the self-hostable project admin share
 * one adapter implementation instead of each maintaining its own.
 */

export const INTEGRATION_KINDS = ["slack", "discord", "datadog", "github"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export const isIntegrationKind = (k: string): k is IntegrationKind =>
  (INTEGRATION_KINDS as readonly string[]).includes(k);

/** Describes one config field a UI should collect for a provider. */
export interface IntegrationConfigField {
  key: string;
  label: string;
  placeholder?: string;
  /** Secret fields are encrypted at rest and masked when read back. */
  secret?: boolean;
}

/** Per-provider config schema — drives the connect dialog in both UIs. */
export const INTEGRATION_FIELDS: Record<IntegrationKind, IntegrationConfigField[]> = {
  slack: [
    { key: "webhookUrl", label: "Incoming webhook URL", placeholder: "https://hooks.slack.com/services/…", secret: true },
  ],
  discord: [
    { key: "webhookUrl", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/…", secret: true },
  ],
  datadog: [
    { key: "apiKey", label: "API key", placeholder: "Datadog API key", secret: true },
    { key: "site", label: "Site (optional)", placeholder: "datadoghq.com" },
  ],
  github: [
    { key: "token", label: "Access token (repo scope)", placeholder: "ghp_…", secret: true },
    { key: "repo", label: "Repository", placeholder: "owner/name" },
  ],
};

/** Config keys holding secrets, per kind — encrypt at rest, mask on read. */
export const SECRET_KEYS: Record<IntegrationKind, string[]> = {
  slack: ["webhookUrl"],
  discord: ["webhookUrl"],
  datadog: ["apiKey"],
  github: ["token"],
};

const maskValue = (v: string): string => (v.length <= 8 ? "••••" : `${v.slice(0, 4)}…${v.slice(-4)}`);

/** Return a copy of `config` with this kind's secret fields masked for display. */
export function maskConfig(kind: string, config: Record<string, unknown>): Record<string, unknown> {
  const secrets = new Set(SECRET_KEYS[kind as IntegrationKind] ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = secrets.has(k) && typeof v === "string" && v ? maskValue(v) : v;
  }
  return out;
}

/** An event to fan out: machine name, one-line human text, and a machine payload. */
export interface IntegrationEvent {
  /** e.g. "item.created" (admin) or "alarm.fired" (cloud) */
  event: string;
  /** one-line message for chat sinks (Slack/Discord) */
  text: string;
  /** machine body for GitHub client_payload / structured sinks */
  payload: Record<string, unknown>;
}

export interface DeliveryOutcome {
  ok: boolean;
  status: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Should a connected integration receive `event`? A `null`/empty subscription
 * means "all events". Supports exact names, `*`, and `prefix.*` wildcards.
 */
export function matchesEventFilter(subscribed: readonly string[] | null | undefined, event: string): boolean {
  if (!subscribed || subscribed.length === 0) return true;
  return subscribed.some(
    (e) => e === event || e === "*" || (e.endsWith(".*") && event.startsWith(e.slice(0, -1))),
  );
}

/**
 * Deliver one event to one connected integration. `config` must already be
 * DECRYPTED by the caller. Best-effort: any error / misconfiguration returns
 * `{ ok: false, status: 0 }` and never throws.
 */
export async function deliverToIntegration(
  kind: string,
  config: Record<string, unknown>,
  evt: IntegrationEvent,
  fetchImpl?: FetchLike,
): Promise<DeliveryOutcome> {
  const doFetch: FetchLike = fetchImpl ?? ((i, init) => fetch(i, init));
  const fail: DeliveryOutcome = { ok: false, status: 0 };
  const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    doFetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

  try {
    if (kind === "slack") {
      const url = config.webhookUrl;
      if (typeof url !== "string" || !url.startsWith("https://hooks.slack.com/")) return fail;
      const r = await json(url, { text: `*${evt.text}*` });
      return { ok: r.ok, status: r.status };
    }
    if (kind === "discord") {
      const url = config.webhookUrl;
      if (typeof url !== "string" || !/^https:\/\/discord(app)?\.com\/api\/webhooks\//.test(url)) return fail;
      const r = await json(url, { content: evt.text });
      return { ok: r.ok, status: r.status };
    }
    if (kind === "datadog") {
      const apiKey = config.apiKey;
      if (typeof apiKey !== "string" || !apiKey) return fail;
      const site = typeof config.site === "string" && config.site ? config.site : "datadoghq.com";
      const r = await json(
        `https://api.${site}/api/v1/events`,
        { title: evt.text, text: evt.text, tags: [`event:${evt.event}`] },
        { "DD-API-KEY": apiKey },
      );
      return { ok: r.ok, status: r.status };
    }
    if (kind === "github") {
      const token = config.token;
      const repo = config.repo; // "owner/name"
      if (typeof token !== "string" || typeof repo !== "string" || !token || !repo) return fail;
      const r = await json(
        `https://api.github.com/repos/${repo}/dispatches`,
        { event_type: `backlex.${evt.event}`, client_payload: evt.payload },
        { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "backlex" },
      );
      return { ok: r.ok, status: r.status };
    }
    return fail;
  } catch {
    return fail;
  }
}
