/**
 * Guards the provider-registry invariants that the old parallel lookup tables
 * couldn't express. These are the failure modes the registry refactor exists to
 * make impossible — a provider registered under the wrong id, a secret field
 * that never gets encrypted, a kind with no implementation behind it.
 */
import { describe, expect, test } from "bun:test";
import {
  INTEGRATION_CATALOG,
  INTEGRATION_FIELDS,
  INTEGRATION_KINDS,
  OAUTH_CONFIG_KEYS,
  OAUTH_KINDS,
  OAUTH_SECRET_KEYS,
  PROVIDERS,
  SECRET_KEYS,
  deliverToIntegration,
  providerFor,
  type IntegrationKind,
} from "@backlex/integrations";

const KINDS = INTEGRATION_KINDS as readonly IntegrationKind[];

describe("provider registry", () => {
  test("every kind resolves to a provider registered under its own id", () => {
    for (const kind of KINDS) {
      const p = providerFor(kind);
      expect(p).toBeDefined();
      // A copy-paste slip in providers/index.ts (`slack, slack,`) is exactly
      // what this catches: the key would resolve, but to the wrong provider.
      expect(p?.id).toBe(kind);
    }
  });

  test("the registry holds no providers outside INTEGRATION_KINDS", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual([...KINDS].sort());
  });

  test("every provider can actually receive events", () => {
    for (const kind of KINDS) {
      expect(PROVIDERS[kind].capabilities).toContain("sink");
      expect(typeof PROVIDERS[kind].deliver).toBe("function");
    }
  });

  test("SECRET_KEYS is derived from the fields marked secret, plus OAuth tokens", () => {
    for (const kind of KINDS) {
      const declared = INTEGRATION_FIELDS[kind].filter((f) => f.secret).map((f) => f.key);
      // An OAuth provider also holds the two bearer tokens, which no provider
      // author lists as a field. Deriving them here is what stops an access
      // token being returned in cleartext by the admin API.
      const expected = PROVIDERS[kind].oauth ? [...declared, ...OAUTH_SECRET_KEYS] : declared;
      expect(SECRET_KEYS[kind]).toEqual(expected);
      // Every non-reserved secret key must name a real field, or
      // encryption-at-rest would silently skip a value the UI does collect.
      const keys = INTEGRATION_FIELDS[kind].map((f) => f.key);
      const reserved = new Set<string>(OAUTH_CONFIG_KEYS);
      for (const s of SECRET_KEYS[kind]) if (!reserved.has(s)) expect(keys).toContain(s);
    }
  });

  test("only OAuth providers carry the reserved token keys", () => {
    const reserved = new Set<string>(OAUTH_SECRET_KEYS);
    for (const kind of KINDS) {
      if (PROVIDERS[kind].oauth) continue;
      // A key-pasting provider that picked one of these up would have a config
      // slot nothing writes and the masking layer would hide the mistake.
      for (const s of SECRET_KEYS[kind]) expect(reserved.has(s)).toBe(false);
    }
  });

  test("every OAuth provider declares the client credentials it needs", () => {
    for (const kind of KINDS) {
      const oauth = PROVIDERS[kind].oauth;
      if (!oauth) continue;
      const keys = INTEGRATION_FIELDS[kind].map((f) => f.key);
      // `beginOAuth` refuses to start without these two, so a provider that
      // omits them from its fields can never be connected at all.
      expect(keys).toContain("clientId");
      expect(keys).toContain("clientSecret");
      expect(INTEGRATION_FIELDS[kind].find((f) => f.key === "clientSecret")?.secret).toBe(true);
      // Both endpoints are fixed constants; a templated one would mean a
      // caller could influence where the credentials are sent.
      expect(oauth.authorizeUrl).toStartWith("https://");
      expect(oauth.tokenUrl).toStartWith("https://");
    }
  });

  test("every provider declares at least one config field and a credential", () => {
    for (const kind of KINDS) {
      expect(INTEGRATION_FIELDS[kind].length).toBeGreaterThan(0);
      expect(SECRET_KEYS[kind].length).toBeGreaterThan(0);
    }
  });

  test("catalog metadata covers every kind exactly once", () => {
    expect(INTEGRATION_CATALOG.map((p) => p.id).sort()).toEqual([...KINDS].sort());
    for (const entry of INTEGRATION_CATALOG) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.fields).toEqual(INTEGRATION_FIELDS[entry.id]);
    }
  });

  test("an unregistered kind fails closed instead of throwing", async () => {
    const evt = { event: "item.created", text: "x", payload: {} };
    const never: typeof fetch = () => {
      throw new Error("must not be called for an unknown kind");
    };
    expect(await deliverToIntegration("not-a-provider", { apiKey: "k" }, evt, never)).toEqual({
      ok: false,
      status: 0,
    });
  });

  test("a provider that throws mid-delivery fails closed", async () => {
    const evt = { event: "item.created", text: "x", payload: {} };
    const boom: typeof fetch = () => Promise.reject(new Error("network down"));
    expect(
      await deliverToIntegration("slack", { webhookUrl: "https://hooks.slack.com/services/x" }, evt, boom),
    ).toEqual({ ok: false, status: 0 });
  });
});

describe("OAUTH_KINDS is derived, not hand-listed", () => {
  test("it names exactly the providers with an oauth block", () => {
    // The connect UI branches on this to show "Connect with …" instead of a
    // paste-a-key form; a hand-kept copy would eventually disagree with the
    // descriptors and offer a form for a provider that has no key to paste.
    expect([...OAUTH_KINDS].sort()).toEqual(KINDS.filter((k) => PROVIDERS[k].oauth).sort());
  });

  test("the catalog's oauth flag agrees with the registry", () => {
    for (const entry of INTEGRATION_CATALOG) {
      expect(entry.oauth).toBe(Boolean(PROVIDERS[entry.id as IntegrationKind].oauth));
    }
  });
});
