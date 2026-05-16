// Worker-only shim for `ldapts`. LDAP needs raw TCP (`node:net`/`node:tls`),
// which Cloudflare Workers don't provide — the LDAP adapter is never selected
// on Workers (see `lib/auth-select.ts::buildLdapAdapter`), so this stub only
// exists to satisfy the bundler's static import resolution. Constructing the
// client throws with a hint to use SAML SSO or move off Workers.
const unavailable = (): never => {
  throw new Error(
    "ldapts is not available on Cloudflare Workers — use SAML SSO or run on Bun/Node",
  );
};

export class Client {
  constructor(_opts?: unknown) {
    unavailable();
  }
}

// Anything else ldapts publishes is re-exported as `undefined` so consumers can
// still type-import (the values are only ever touched after `new Client(...)`,
// which already threw). Adjust if a route ever needs a type or constant from
// the real package at module-load time.
export const Attribute = undefined as unknown;
export const Change = undefined as unknown;
export const Control = undefined as unknown;
export const Filter = undefined as unknown;

export default { Client };
