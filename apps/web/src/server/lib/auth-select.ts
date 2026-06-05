/**
 * Selection layer for the auth-related adapters. Lives alongside
 * `email-select.ts` and `image-select.ts`. Covers SAML (Phase 1) and LDAP
 * (Phase 2).
 *
 * SAML works on Bun and Cloudflare Workers (samlify uses `node:crypto`,
 * which Workers expose under `nodejs_compat`). Vercel Edge (V8 isolate, no
 * full node:crypto) and Netlify Edge (Deno Deploy) do NOT support samlify;
 * `buildSamlAdapter` returns `undefined` on those and the route layer maps
 * that to a 503 "UNAVAILABLE".
 *
 * LDAP needs raw TCP via `node:net`/`node:tls`. None of the edge runtimes
 * expose that, so `buildLdapAdapter` returns `undefined` on every edge
 * runtime; the route layer maps that to a 503 "UNAVAILABLE" so tenants
 * either configure SAML or run the app on Bun / a Node host.
 */
import type { LdapAdapter, SamlAdapter } from "@backlex/core/adapters";
import { type LdapSpec, ldaptsLdapAdapter } from "../adapters/ldap.ldapts";
import { isEdgeRuntime, isStatelessEdge } from "./runtime";

/**
 * Wire a {@link SamlAdapter}. Returns `undefined` on Vercel Edge / Netlify
 * Edge — samlify's transitive `xml-crypto` dependency relies on Node's
 * `crypto` module surface that those runtimes don't fully provide. Callers
 * should surface that as 503 "SAML is not available on this runtime —
 * deploy to Bun or Cloudflare Workers instead".
 *
 * Async because the samlify adapter (samlify + its @peculiar/asn1 + node-rsa +
 * xml-crypto graph — a large slice of the bundle) is **dynamically imported**
 * here so it stays out of the worker's cold-start eval path. Only a request
 * that actually resolves a SAML provider pays the load.
 */
export const buildSamlAdapter = async (): Promise<SamlAdapter | undefined> => {
  if (isStatelessEdge()) {
    console.warn(
      "[saml] not available on Vercel Edge / Netlify Edge — deploy to Bun or Cloudflare Workers instead",
    );
    return undefined;
  }
  const { samlifySamlAdapter } = await import("../adapters/saml.samlify");
  return samlifySamlAdapter();
};

/**
 * Tests-only override: when set, `buildLdapAdapter` returns this adapter
 * factory's output instead of building a real ldapts one. Lets the LDAP
 * route tests inject a fake directory without monkey-patching the package.
 * Reset by passing `null`.
 */
let ldapAdapterOverride:
  | ((spec: LdapSpec) => LdapAdapter | undefined)
  | null = null;

/** Tests-only. Use `null` to clear the override. */
export const __setLdapAdapterFactoryForTests = (
  override: ((spec: LdapSpec) => LdapAdapter | undefined) | null,
): void => {
  ldapAdapterOverride = override;
};

/**
 * Wire an {@link LdapAdapter} for a resolved LDAP config. Returns `undefined`
 * on every edge runtime (no raw TCP); callers should surface that as
 * 503 "LDAP is not available on this runtime — configure SAML instead".
 */
export const buildLdapAdapter = (spec: LdapSpec): LdapAdapter | undefined => {
  if (ldapAdapterOverride) return ldapAdapterOverride(spec);
  if (isEdgeRuntime()) {
    console.warn(
      "[ldap] not available on edge runtimes (Cloudflare Workers / Vercel Edge / Netlify Edge) — configure SAML instead",
    );
    return undefined;
  }
  return ldaptsLdapAdapter(spec);
};
