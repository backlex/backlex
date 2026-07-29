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

  test("SECRET_KEYS is derived from the fields marked secret", () => {
    for (const kind of KINDS) {
      const declared = INTEGRATION_FIELDS[kind].filter((f) => f.secret).map((f) => f.key);
      expect(SECRET_KEYS[kind]).toEqual(declared);
      // Every secret key must name a real field, or encryption-at-rest would
      // silently skip a value the UI does collect.
      const keys = INTEGRATION_FIELDS[kind].map((f) => f.key);
      for (const s of SECRET_KEYS[kind]) expect(keys).toContain(s);
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
