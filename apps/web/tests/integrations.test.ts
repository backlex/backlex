import { describe, expect, test } from "bun:test";
import {
  INTEGRATION_KINDS,
  INTEGRATION_FIELDS,
  SECRET_KEYS,
  deliverToIntegration,
  isIntegrationKind,
  maskConfig,
  matchesEventFilter,
  type FetchLike,
} from "@backlex/integrations";

/** Capture the last request a delivery made. */
function recorder(status = 200): { fetch: FetchLike; calls: { url: string; body: unknown; headers: Record<string, string> }[] } {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return new Response(null, { status }) as unknown as Response;
  };
  return { fetch, calls };
}

const evt = { event: "item.created", text: "New order #42", payload: { id: "42" } };

describe("@backlex/integrations adapters", () => {
  test("slack posts {text} to a hooks.slack.com URL", async () => {
    const rec = recorder();
    const out = await deliverToIntegration("slack", { webhookUrl: "https://hooks.slack.com/services/X" }, evt, rec.fetch);
    expect(out.ok).toBe(true);
    expect(rec.calls[0]!.url).toBe("https://hooks.slack.com/services/X");
    expect(rec.calls[0]!.body).toEqual({ text: "*New order #42*" });
  });

  test("discord posts {content} to a discord webhook URL", async () => {
    const rec = recorder();
    const out = await deliverToIntegration("discord", { webhookUrl: "https://discord.com/api/webhooks/1/abc" }, evt, rec.fetch);
    expect(out.ok).toBe(true);
    expect(rec.calls[0]!.body).toEqual({ content: "New order #42" });
  });

  test("datadog posts to the events API of the configured site with DD-API-KEY", async () => {
    const rec = recorder();
    await deliverToIntegration("datadog", { apiKey: "dd", site: "datadoghq.eu" }, evt, rec.fetch);
    expect(rec.calls[0]!.url).toBe("https://api.datadoghq.eu/api/v1/events");
    expect(rec.calls[0]!.headers["DD-API-KEY"]).toBe("dd");
    expect(rec.calls[0]!.body).toMatchObject({ tags: ["event:item.created"] });
  });

  test("github fires a repository_dispatch with backlex.<event> + client_payload", async () => {
    const rec = recorder(204);
    const out = await deliverToIntegration("github", { token: "ghp_x", repo: "acme/app" }, evt, rec.fetch);
    expect(out.ok).toBe(true);
    expect(rec.calls[0]!.url).toBe("https://api.github.com/repos/acme/app/dispatches");
    expect(rec.calls[0]!.headers.Authorization).toBe("Bearer ghp_x");
    expect(rec.calls[0]!.body).toEqual({ event_type: "backlex.item.created", client_payload: { id: "42" } });
  });

  test("teams posts {text} to its incoming webhook URL", async () => {
    const rec = recorder();
    const out = await deliverToIntegration("teams", { webhookUrl: "https://acme.webhook.office.com/x" }, evt, rec.fetch);
    expect(out.ok).toBe(true);
    expect(rec.calls[0]!.body).toEqual({ text: "New order #42" });
  });

  test("telegram calls sendMessage with chat_id + text", async () => {
    const rec = recorder();
    await deliverToIntegration("telegram", { botToken: "123:abc", chatId: "-100" }, evt, rec.fetch);
    expect(rec.calls[0]!.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(rec.calls[0]!.body).toEqual({ chat_id: "-100", text: "New order #42" });
  });

  test("sentry posts a store event with X-Sentry-Auth derived from the DSN", async () => {
    const rec = recorder();
    await deliverToIntegration("sentry", { dsn: "https://pub123@o1.ingest.sentry.io/456" }, evt, rec.fetch);
    expect(rec.calls[0]!.url).toBe("https://o1.ingest.sentry.io/api/456/store/");
    expect(rec.calls[0]!.headers["X-Sentry-Auth"]).toContain("sentry_key=pub123");
    expect(rec.calls[0]!.body).toMatchObject({ message: "New order #42", tags: { event: "item.created" } });
  });

  test("pagerduty enqueues a trigger event", async () => {
    const rec = recorder(202);
    const out = await deliverToIntegration("pagerduty", { routingKey: "rk" }, evt, rec.fetch);
    expect(out.ok).toBe(true);
    expect(rec.calls[0]!.url).toBe("https://events.pagerduty.com/v2/enqueue");
    expect(rec.calls[0]!.body).toMatchObject({ routing_key: "rk", event_action: "trigger" });
  });

  test("opsgenie posts to the regional alerts API with GenieKey auth", async () => {
    const rec = recorder(202);
    await deliverToIntegration("opsgenie", { apiKey: "k", region: "eu" }, evt, rec.fetch);
    expect(rec.calls[0]!.url).toBe("https://api.eu.opsgenie.com/v2/alerts");
    expect(rec.calls[0]!.headers.Authorization).toBe("GenieKey k");
  });

  test("posthog captures an event to the configured host", async () => {
    const rec = recorder();
    await deliverToIntegration("posthog", { apiKey: "phc_x", host: "eu.i.posthog.com" }, evt, rec.fetch);
    expect(rec.calls[0]!.url).toBe("https://eu.i.posthog.com/capture/");
    expect(rec.calls[0]!.body).toMatchObject({ api_key: "phc_x", event: "item.created", distinct_id: "42" });
  });

  test("segment tracks with Basic write-key auth", async () => {
    const rec = recorder();
    await deliverToIntegration("segment", { writeKey: "wk" }, evt, rec.fetch);
    expect(rec.calls[0]!.url).toBe("https://api.segment.io/v1/track");
    expect(rec.calls[0]!.headers.Authorization).toBe(`Basic ${btoa("wk:")}`);
    expect(rec.calls[0]!.body).toMatchObject({ event: "item.created", userId: "42" });
  });

  test("webhook POSTs the event and signs with HMAC when a secret is set", async () => {
    const rec = recorder();
    const out = await deliverToIntegration("webhook", { url: "https://example.com/hook", signingSecret: "s3cr3t" }, evt, rec.fetch);
    expect(out.ok).toBe(true);
    expect(rec.calls[0]!.url).toBe("https://example.com/hook");
    expect(rec.calls[0]!.body).toEqual({ event: "item.created", text: "New order #42", payload: { id: "42" } });
    expect(rec.calls[0]!.headers["X-Backlex-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  test("linear creates an issue via GraphQL with the team id", async () => {
    const rec = recorder();
    await deliverToIntegration("linear", { apiKey: "lin", teamId: "team-1" }, evt, rec.fetch);
    expect(rec.calls[0]!.url).toBe("https://api.linear.app/graphql");
    expect(rec.calls[0]!.headers.Authorization).toBe("lin");
    expect(rec.calls[0]!.body).toMatchObject({ variables: { input: { teamId: "team-1", title: "New order #42" } } });
  });

  test("jira creates an issue with Basic auth and an ADF description", async () => {
    const rec = recorder(201);
    await deliverToIntegration(
      "jira",
      { baseUrl: "https://acme.atlassian.net", email: "a@b.co", apiToken: "tok", projectKey: "ENG" },
      evt,
      rec.fetch,
    );
    expect(rec.calls[0]!.url).toBe("https://acme.atlassian.net/rest/api/3/issue");
    expect(rec.calls[0]!.headers.Authorization).toBe(`Basic ${btoa("a@b.co:tok")}`);
    expect(rec.calls[0]!.body).toMatchObject({ fields: { project: { key: "ENG" }, summary: "New order #42" } });
  });

  test("algolia upserts a record using the record id as objectID", async () => {
    const rec = recorder();
    await deliverToIntegration("algolia", { appId: "APP", apiKey: "key", indexName: "items" }, evt, rec.fetch);
    expect(rec.calls[0]!.url).toBe("https://APP.algolia.net/1/indexes/items");
    expect(rec.calls[0]!.headers["X-Algolia-Application-Id"]).toBe("APP");
    expect(rec.calls[0]!.body).toEqual({ id: "42", objectID: "42" });
  });

  test("meilisearch posts a document array with an id primary key", async () => {
    const rec = recorder(202);
    await deliverToIntegration("meilisearch", { host: "ms.example.com", apiKey: "key", indexName: "items" }, evt, rec.fetch);
    expect(rec.calls[0]!.url).toBe("https://ms.example.com/indexes/items/documents");
    expect(rec.calls[0]!.headers.Authorization).toBe("Bearer key");
    expect(rec.calls[0]!.body).toEqual([{ id: "42" }]);
  });

  test("misconfigured providers fail closed (no throw, ok:false)", async () => {
    const rec = recorder();
    expect((await deliverToIntegration("slack", { webhookUrl: "https://evil.test" }, evt, rec.fetch)).ok).toBe(false);
    expect((await deliverToIntegration("github", { token: "x" }, evt, rec.fetch)).ok).toBe(false);
    expect((await deliverToIntegration("unknown", {}, evt, rec.fetch)).ok).toBe(false);
    expect(rec.calls).toHaveLength(0);
  });
});

describe("@backlex/integrations helpers", () => {
  test("kinds + field/secret maps stay in sync", () => {
    for (const kind of INTEGRATION_KINDS) {
      expect(isIntegrationKind(kind)).toBe(true);
      expect(INTEGRATION_FIELDS[kind].length).toBeGreaterThan(0);
      // every secret key is a declared field
      for (const sk of SECRET_KEYS[kind]) {
        expect(INTEGRATION_FIELDS[kind].some((f) => f.key === sk && f.secret)).toBe(true);
      }
    }
    expect(isIntegrationKind("mailchimp")).toBe(false);
  });

  test("maskConfig masks only secret keys", () => {
    const masked = maskConfig("github", { token: "ghp_supersecrettoken", repo: "acme/app" });
    expect(masked.repo).toBe("acme/app");
    expect(masked.token).toBe("ghp_…oken");
  });

  test("matchesEventFilter: null/empty = all, supports * and prefix.*", () => {
    expect(matchesEventFilter(null, "alarm.fired")).toBe(true);
    expect(matchesEventFilter([], "alarm.fired")).toBe(true);
    expect(matchesEventFilter(["*"], "alarm.fired")).toBe(true);
    expect(matchesEventFilter(["alarm.fired"], "alarm.fired")).toBe(true);
    expect(matchesEventFilter(["project.*"], "project.provisioned")).toBe(true);
    expect(matchesEventFilter(["project.*"], "alarm.fired")).toBe(false);
  });
});
