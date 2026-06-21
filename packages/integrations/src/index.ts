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

export const INTEGRATION_KINDS = [
  // chat
  "slack",
  "discord",
  "teams",
  "telegram",
  // observability / alerting
  "datadog",
  "sentry",
  "pagerduty",
  "opsgenie",
  // analytics
  "posthog",
  "segment",
  // automation / issue tracking
  "github",
  "webhook",
  "linear",
  "jira",
  // search sync
  "algolia",
  "meilisearch",
] as const;
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
  teams: [
    { key: "webhookUrl", label: "Incoming webhook URL", placeholder: "https://…webhook.office.com/…", secret: true },
  ],
  telegram: [
    { key: "botToken", label: "Bot token", placeholder: "123456:ABC-DEF…", secret: true },
    { key: "chatId", label: "Chat ID", placeholder: "-1001234567890" },
  ],
  datadog: [
    { key: "apiKey", label: "API key", placeholder: "Datadog API key", secret: true },
    { key: "site", label: "Site (optional)", placeholder: "datadoghq.com" },
  ],
  sentry: [
    { key: "dsn", label: "DSN", placeholder: "https://<key>@<host>/<project>", secret: true },
  ],
  pagerduty: [
    { key: "routingKey", label: "Integration routing key", placeholder: "Events API v2 key", secret: true },
  ],
  opsgenie: [
    { key: "apiKey", label: "API key", placeholder: "Opsgenie API integration key", secret: true },
    { key: "region", label: "Region (optional)", placeholder: "us or eu" },
  ],
  posthog: [
    { key: "apiKey", label: "Project API key", placeholder: "phc_…", secret: true },
    { key: "host", label: "Host (optional)", placeholder: "https://us.i.posthog.com" },
  ],
  segment: [
    { key: "writeKey", label: "Write key", placeholder: "Segment source write key", secret: true },
  ],
  github: [
    { key: "token", label: "Access token (repo scope)", placeholder: "ghp_…", secret: true },
    { key: "repo", label: "Repository", placeholder: "owner/name" },
  ],
  webhook: [
    { key: "url", label: "Endpoint URL", placeholder: "https://example.com/hooks/backlex", secret: true },
    { key: "signingSecret", label: "Signing secret (optional)", placeholder: "HMAC-SHA256 secret", secret: true },
  ],
  linear: [
    { key: "apiKey", label: "API key", placeholder: "lin_api_…", secret: true },
    { key: "teamId", label: "Team ID", placeholder: "UUID of the team" },
  ],
  jira: [
    { key: "baseUrl", label: "Base URL", placeholder: "https://your-org.atlassian.net" },
    { key: "email", label: "Account email", placeholder: "you@example.com" },
    { key: "apiToken", label: "API token", placeholder: "Atlassian API token", secret: true },
    { key: "projectKey", label: "Project key", placeholder: "ENG" },
  ],
  algolia: [
    { key: "appId", label: "Application ID", placeholder: "Algolia app ID" },
    { key: "apiKey", label: "Admin API key", placeholder: "Write-enabled key", secret: true },
    { key: "indexName", label: "Index name", placeholder: "items" },
  ],
  meilisearch: [
    { key: "host", label: "Host", placeholder: "https://ms.example.com" },
    { key: "apiKey", label: "API key", placeholder: "Master or write key", secret: true },
    { key: "indexName", label: "Index name", placeholder: "items" },
  ],
};

/** Config keys holding secrets, per kind — encrypt at rest, mask on read. */
export const SECRET_KEYS: Record<IntegrationKind, string[]> = {
  slack: ["webhookUrl"],
  discord: ["webhookUrl"],
  teams: ["webhookUrl"],
  telegram: ["botToken"],
  datadog: ["apiKey"],
  sentry: ["dsn"],
  pagerduty: ["routingKey"],
  opsgenie: ["apiKey"],
  posthog: ["apiKey"],
  segment: ["writeKey"],
  github: ["token"],
  webhook: ["url", "signingSecret"],
  linear: ["apiKey"],
  jira: ["apiToken"],
  algolia: ["apiKey"],
  meilisearch: ["apiKey"],
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

/** base64 (Workers/Bun/Node 18+ `btoa`); null if unavailable. */
function b64(s: string): string | null {
  try {
    return typeof btoa === "function" ? btoa(s) : null;
  } catch {
    return null;
  }
}

/** Lowercase-hex HMAC-SHA256 via Web Crypto; null if crypto is unavailable. */
async function hmacHex(secret: string, body: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const enc = new TextEncoder();
    const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await subtle.sign("HMAC", key, enc.encode(body));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Trim a trailing slash and default to https:// when no scheme is given. */
function asHttpsBase(host: string): string {
  const s = host.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/** A stable id for search/analytics sinks: the record id when present. */
function recordId(payload: Record<string, unknown>, fallback: string): string {
  const id = payload.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : fallback;
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
    if (kind === "teams") {
      const url = config.webhookUrl;
      if (typeof url !== "string" || !url.startsWith("https://")) return fail;
      const r = await json(url, { text: evt.text });
      return { ok: r.ok, status: r.status };
    }
    if (kind === "telegram") {
      const token = config.botToken;
      const chatId = config.chatId;
      if (typeof token !== "string" || !token || typeof chatId !== "string" || !chatId) return fail;
      const r = await json(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: evt.text });
      return { ok: r.ok, status: r.status };
    }
    if (kind === "sentry") {
      const dsn = config.dsn;
      if (typeof dsn !== "string" || !dsn) return fail;
      let publicKey = "";
      let host = "";
      let projectId = "";
      try {
        const u = new URL(dsn);
        publicKey = u.username;
        host = u.host;
        projectId = u.pathname.replace(/^\/+/, "");
      } catch {
        return fail;
      }
      if (!publicKey || !host || !projectId) return fail;
      const r = await json(
        `https://${host}/api/${projectId}/store/`,
        { message: evt.text, level: "info", platform: "other", tags: { event: evt.event }, extra: evt.payload },
        { "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=backlex/1, sentry_key=${publicKey}` },
      );
      return { ok: r.ok, status: r.status };
    }
    if (kind === "pagerduty") {
      const routingKey = config.routingKey;
      if (typeof routingKey !== "string" || !routingKey) return fail;
      const r = await json("https://events.pagerduty.com/v2/enqueue", {
        routing_key: routingKey,
        event_action: "trigger",
        payload: { summary: evt.text, source: "backlex", severity: "info", custom_details: evt.payload },
      });
      return { ok: r.ok, status: r.status };
    }
    if (kind === "opsgenie") {
      const apiKey = config.apiKey;
      if (typeof apiKey !== "string" || !apiKey) return fail;
      const region = typeof config.region === "string" && config.region.trim().toLowerCase() === "eu" ? "api.eu." : "api.";
      const r = await json(
        `https://${region}opsgenie.com/v2/alerts`,
        { message: evt.text, tags: [`event:${evt.event}`], details: { event: evt.event } },
        { Authorization: `GenieKey ${apiKey}` },
      );
      return { ok: r.ok, status: r.status };
    }
    if (kind === "posthog") {
      const apiKey = config.apiKey;
      if (typeof apiKey !== "string" || !apiKey) return fail;
      const host = typeof config.host === "string" && config.host ? asHttpsBase(config.host) : "https://us.i.posthog.com";
      const r = await json(`${host}/capture/`, {
        api_key: apiKey,
        event: evt.event,
        distinct_id: recordId(evt.payload, "backlex"),
        properties: { ...evt.payload, $lib: "backlex" },
      });
      return { ok: r.ok, status: r.status };
    }
    if (kind === "segment") {
      const writeKey = config.writeKey;
      if (typeof writeKey !== "string" || !writeKey) return fail;
      const auth = b64(`${writeKey}:`);
      if (!auth) return fail;
      const r = await json(
        "https://api.segment.io/v1/track",
        { event: evt.event, userId: recordId(evt.payload, "backlex"), properties: evt.payload },
        { Authorization: `Basic ${auth}` },
      );
      return { ok: r.ok, status: r.status };
    }
    if (kind === "webhook") {
      const url = config.url;
      if (typeof url !== "string" || !url.startsWith("https://")) return fail;
      const body = JSON.stringify({ event: evt.event, text: evt.text, payload: evt.payload });
      const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "backlex" };
      const signingSecret = config.signingSecret;
      if (typeof signingSecret === "string" && signingSecret) {
        const sig = await hmacHex(signingSecret, body);
        if (sig) headers["X-Backlex-Signature"] = `sha256=${sig}`;
      }
      const r = await doFetch(url, { method: "POST", headers, body });
      return { ok: r.ok, status: r.status };
    }
    if (kind === "linear") {
      const apiKey = config.apiKey;
      const teamId = config.teamId;
      if (typeof apiKey !== "string" || !apiKey || typeof teamId !== "string" || !teamId) return fail;
      const r = await json(
        "https://api.linear.app/graphql",
        {
          query: "mutation($input: IssueCreateInput!){ issueCreate(input: $input){ success } }",
          variables: { input: { teamId, title: evt.text, description: `Event \`${evt.event}\`\n\n\`\`\`json\n${JSON.stringify(evt.payload, null, 2)}\n\`\`\`` } },
        },
        { Authorization: apiKey },
      );
      return { ok: r.ok, status: r.status };
    }
    if (kind === "jira") {
      const baseUrl = config.baseUrl;
      const email = config.email;
      const apiToken = config.apiToken;
      const projectKey = config.projectKey;
      if ([baseUrl, email, apiToken, projectKey].some((v) => typeof v !== "string" || !v)) return fail;
      const auth = b64(`${email}:${apiToken}`);
      if (!auth) return fail;
      const r = await json(
        `${asHttpsBase(baseUrl as string)}/rest/api/3/issue`,
        {
          fields: {
            project: { key: projectKey },
            summary: evt.text,
            issuetype: { name: "Task" },
            description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: evt.text }] }] },
          },
        },
        { Authorization: `Basic ${auth}` },
      );
      return { ok: r.ok, status: r.status };
    }
    if (kind === "algolia") {
      const appId = config.appId;
      const apiKey = config.apiKey;
      const indexName = config.indexName;
      if ([appId, apiKey, indexName].some((v) => typeof v !== "string" || !v)) return fail;
      const r = await json(
        `https://${appId}.algolia.net/1/indexes/${encodeURIComponent(indexName as string)}`,
        { ...evt.payload, objectID: recordId(evt.payload, evt.event) },
        { "X-Algolia-Application-Id": appId as string, "X-Algolia-API-Key": apiKey as string },
      );
      return { ok: r.ok, status: r.status };
    }
    if (kind === "meilisearch") {
      const host = config.host;
      const apiKey = config.apiKey;
      const indexName = config.indexName;
      if ([host, apiKey, indexName].some((v) => typeof v !== "string" || !v)) return fail;
      const r = await json(
        `${asHttpsBase(host as string)}/indexes/${encodeURIComponent(indexName as string)}/documents`,
        [{ ...evt.payload, id: recordId(evt.payload, evt.event) }],
        { Authorization: `Bearer ${apiKey}` },
      );
      return { ok: r.ok, status: r.status };
    }
    return fail;
  } catch {
    return fail;
  }
}
