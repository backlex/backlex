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
  SOURCE_KINDS,
  SOURCE_SETTING_FIELDS,
  DESTINATION_KINDS,
  DESTINATION_SETTING_FIELDS,
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
      const p = PROVIDERS[kind];
      // A provider is a sink, a source, or both — but whichever it claims, the
      // matching implementation has to be there. A capability with no code
      // behind it shows up in the catalog and then does nothing.
      expect(p.capabilities.length).toBeGreaterThan(0);
      if (p.capabilities.includes("sink")) expect(typeof p.deliver).toBe("function");
      if (p.capabilities.includes("source")) expect(typeof p.source?.pull).toBe("function");
      if (p.capabilities.includes("destination")) {
        expect(typeof p.destination?.push).toBe("function");
      }
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

describe("SOURCE_KINDS is derived, not hand-listed", () => {
  test("capabilities and the source block agree in both directions", () => {
    for (const kind of KINDS) {
      const p = PROVIDERS[kind];
      // Two ways to say the same thing is two ways to be wrong: a `source`
      // block without the capability is invisible to the catalog, and the
      // capability without the block is a sync that throws on its first run.
      expect(Boolean(p.source)).toBe(p.capabilities.includes("source"));
    }
  });

  test("it names exactly the providers that can pull", () => {
    expect([...SOURCE_KINDS].sort()).toEqual(KINDS.filter((k) => PROVIDERS[k].source).sort());
  });

  test("destinations agree the same way, in both directions", () => {
    for (const kind of KINDS) {
      const p = PROVIDERS[kind];
      // Same trap as `source`: a block without the capability is invisible to
      // the catalog, and the capability without a block is a sync that throws
      // on its first push.
      expect(Boolean(p.destination)).toBe(p.capabilities.includes("destination"));
    }
    expect([...DESTINATION_KINDS].sort()).toEqual(KINDS.filter((k) => PROVIDERS[k].destination).sort());
  });

  test("every destination declares the settings it will read", () => {
    for (const kind of DESTINATION_KINDS) {
      const fields = DESTINATION_SETTING_FIELDS[kind];
      expect(fields?.length ?? 0).toBeGreaterThan(0);
      for (const f of fields!) {
        expect(f.key).toBeTruthy();
        // Settings are stored and returned in cleartext by contract.
        expect(f.secret).toBeFalsy();
      }
    }
  });

  test("every source declares the settings it will read", () => {
    for (const kind of SOURCE_KINDS) {
      const fields = SOURCE_SETTING_FIELDS[kind];
      // The engine refuses any setting not declared here, so an empty list
      // would make the provider unconfigurable rather than permissive.
      expect(fields?.length ?? 0).toBeGreaterThan(0);
      for (const f of fields!) {
        expect(f.key).toBeTruthy();
        expect(f.label).toBeTruthy();
        // Settings are stored and returned in cleartext by contract; a secret
        // one would be published by the sync list endpoint.
        expect(f.secret).toBeFalsy();
      }
    }
  });
});

describe("choice settings are a closed set end to end", () => {
  test("every option-bearing field declares real, distinct values", () => {
    for (const kind of SOURCE_KINDS) {
      for (const f of SOURCE_SETTING_FIELDS[kind] ?? []) {
        if (!f.options) continue;
        expect(f.options.length).toBeGreaterThan(1);
        const values = f.options.map((o) => o.value);
        // A duplicate would make one entry unreachable in the picker while
        // still passing the server's membership check.
        expect(new Set(values).size).toBe(values.length);
        for (const o of f.options) {
          expect(o.value).toBeTruthy();
          expect(o.label).toBeTruthy();
        }
      }
    }
  });

  test("an option label is short enough to still read at phone width", () => {
    // The settings picker draws the SELECTED label in full rather than
    // truncating it — that is deliberate, so a label always reads whole — which
    // means a label that does not fit is clipped instead, at exactly the width
    // where an operator most needs to see which option is chosen. A sentence
    // belongs in docs/integrations.md; the option gets a phrase.
    const cap = 40;
    const tooLong: string[] = [];
    for (const [kind, fields] of [
      ...Object.entries(SOURCE_SETTING_FIELDS),
      ...Object.entries(DESTINATION_SETTING_FIELDS),
    ]) {
      for (const f of fields ?? []) {
        for (const o of f.options ?? []) {
          if (o.label.length > cap) tooLong.push(`${kind}.${f.key} → "${o.label}"`);
        }
      }
    }
    // Asserted as a list so a failure names the offender rather than reporting
    // that some number was larger than forty.
    expect(tooLong).toEqual([]);
  });

  test("a provider that builds a URL from a setting constrains it", () => {
    // QuickBooks interpolates the record type into its query string and Xero
    // into a URL path segment. Free text there is the difference between a
    // typo and a request nobody intended, so both must be closed sets.
    for (const kind of ["quickbooks", "xero"] as const) {
      const fields = SOURCE_SETTING_FIELDS[kind] ?? [];
      const recordType = fields.find((f) => f.key === "entity" || f.key === "endpoint");
      expect(recordType?.options?.length ?? 0).toBeGreaterThan(1);
    }
  });
});

describe("OAuth providers that need more than a token say so", () => {
  test("QuickBooks captures the company id from the redirect", () => {
    // It is on the callback query and nowhere in the token response; without
    // this the connection authorizes cleanly and then fails on every call.
    expect(PROVIDERS.quickbooks.oauth?.keepFromCallbackQuery).toContain("realmId");
  });

  test("Xero asks for offline_access, without which no refresh token is issued", () => {
    expect(PROVIDERS.xero.oauth?.scopes).toContain("offline_access");
  });

  test("Google asks for the two params that make a refresh token appear", () => {
    const params = PROVIDERS["google-sheets"].oauth?.authorizeParams ?? {};
    expect(params.access_type).toBe("offline");
    expect(params.prompt).toBe("consent");
  });
});
