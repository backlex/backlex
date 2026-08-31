import type { ClientCore } from "../core";

/**
 * An outbound webhook: where a workspace event is delivered, and what happens
 * when the endpoint stops answering.
 *
 * **The secret is not on the list.** It signs each delivery as an HMAC-SHA256
 * in `X-Backlex-Signature`, and `list()` reports only whether a hook has one.
 * The plaintext is reachable through `get(id)` — an operator legitimately
 * re-reads it to configure the receiving endpoint — but a list response is the
 * thing that gets logged, pasted into an issue, or handed to an agent, so it
 * does not travel there.
 */
export interface Webhook {
  id: string;
  tenantId: string | null;
  name: string;
  url: string;
  /** Event patterns this hook subscribes to, e.g. `items.posts.created`. */
  events: string[];
  /** Custom request headers sent on every delivery. */
  headers: Record<string, string> | null;
  /** When set, the delivery payload is narrowed to these fields. */
  payloadFields?: string[] | null;
  /** Whether a signing secret is set. The value itself comes from `get(id)`. */
  hasSecret: boolean;
  active: boolean;
  /** Consecutive failed deliveries since the last success. */
  consecutiveFailures?: number | null;
  lastFailureAt?: number | string | null;
  /**
   * Set when the breaker auto-disabled this hook after repeated failures, and
   * null otherwise. A hook can therefore be `active: false` for two different
   * reasons — someone switched it off, or it broke — and this is what tells
   * them apart.
   */
  disabledReason?: string | null;
}

export interface WebhookInput {
  name: string;
  url: string;
  /** At least one pattern; see the event-pattern syntax in the docs. */
  events: string[];
  headers?: Record<string, string> | null;
  payloadFields?: string[] | null;
  /** Signs every delivery as `X-Backlex-Signature` (HMAC-SHA256). */
  secret?: string;
  active?: boolean;
}

/** One attempt at delivering one event to one hook. */
export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  /** The endpoint's HTTP status, or null when the request never completed. */
  status: number | null;
  error?: string | null;
  payload?: unknown;
  response?: unknown;
  createdAt?: number | string | null;
}

export interface WebhookDeliveryQuery {
  webhookId?: string;
  event?: string;
  limit?: number;
  offset?: number;
}

export interface WebhooksClient {
  list: () => Promise<{ data: Webhook[] }>;
  /** One hook, including the plaintext signing secret. The only surface that
   *  returns it — see the note at the top of this file. */
  get: (id: string) => Promise<{ data: Webhook & { secret: string | null } }>;
  create: (input: WebhookInput) => Promise<{ data: Webhook }>;
  /** Omit `secret` to keep the stored one. */
  update: (id: string, patch: Partial<WebhookInput>) => Promise<{ data: Webhook }>;
  delete: (id: string) => Promise<{ ok: boolean }>;
  /**
   * Send one representative delivery now. This is how an operator tells a hook
   * that refuses deliberately from one whose endpoint is down — both look
   * identical in the delivery log.
   */
  test: (id: string) => Promise<{ ok: boolean; status?: number; error?: string }>;
  /** The delivery log, newest first. */
  deliveries: (query?: WebhookDeliveryQuery) => Promise<{ data: WebhookDelivery[] }>;
  /**
   * Re-send one delivery. Re-enables a hook the breaker disabled if it
   * succeeds — which is the only way back without editing the hook.
   */
  retryDelivery: (deliveryId: string) => Promise<{ ok: boolean }>;
}

export const makeWebhooks = (core: ClientCore): WebhooksClient => {
  // Outbound webhooks. Admin-scoped over `/api/webhooks`.
  const hook = (id: string) => `/api/webhooks/${encodeURIComponent(id)}`;
  const qs = (query?: WebhookDeliveryQuery): string => {
    if (!query) return "";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : "";
  };

  const webhooks: WebhooksClient = {
    list: () => core.request<{ data: Webhook[] }>("GET", "/api/webhooks"),
    get: (id) => core.request<{ data: Webhook & { secret: string | null } }>("GET", hook(id)),
    create: (input) => core.request<{ data: Webhook }>("POST", "/api/webhooks", input),
    update: (id, patch) => core.request<{ data: Webhook }>("PATCH", hook(id), patch),
    delete: (id) => core.request<{ ok: boolean }>("DELETE", hook(id)),
    test: (id) =>
      core.request<{ ok: boolean; status?: number; error?: string }>("POST", `${hook(id)}/test`, {}),
    deliveries: (query) =>
      core.request<{ data: WebhookDelivery[] }>("GET", `/api/webhooks/_deliveries${qs(query)}`),
    retryDelivery: (deliveryId) =>
      core.request<{ ok: boolean }>(
        "POST",
        `/api/webhooks/_deliveries/${encodeURIComponent(deliveryId)}/retry`,
        {},
      ),
  };

  return webhooks;
};
