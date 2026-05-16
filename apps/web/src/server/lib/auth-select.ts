/**
 * Selection layer for the auth-related adapters. Lives alongside
 * `email-select.ts` and `image-select.ts`. Covers SAML (Phase 1) and LDAP
 * (Phase 2).
 *
 * SAML works on every runtime — samlify uses `node:crypto`, which Workers
 * provides under `nodejs_compat` (apps/web/wrangler.toml).
 *
 * LDAP needs raw TCP via `node:net`/`node:tls`, which Workers don't expose.
 * `buildLdapAdapter` returns `undefined` on Workers; the route layer maps
 * that to a 503 "UNAVAILABLE" so tenants either configure SAML or run the
 * app on Bun / Vercel / Netlify.
 */
import type { LdapAdapter, SamlAdapter } from "@workeros/core/adapters";
import { samlifySamlAdapter } from "../adapters/saml.samlify";
import { ldaptsLdapAdapter, type LdapSpec } from "../adapters/ldap.ldapts";
import { onCloudflareWorkers } from "./email-select";

export const buildSamlAdapter = (): SamlAdapter => samlifySamlAdapter();

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
 * on Cloudflare Workers (no raw TCP); callers should surface that as
 * 503 "LDAP is not available on this runtime — configure SAML instead".
 */
export const buildLdapAdapter = (spec: LdapSpec): LdapAdapter | undefined => {
  if (ldapAdapterOverride) return ldapAdapterOverride(spec);
  if (onCloudflareWorkers()) {
    console.warn(
      "[ldap] not available on Cloudflare Workers — configure SAML instead",
    );
    return undefined;
  }
  return ldaptsLdapAdapter(spec);
};
