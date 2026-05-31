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
    expect(isIntegrationKind("sentry")).toBe(false);
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
