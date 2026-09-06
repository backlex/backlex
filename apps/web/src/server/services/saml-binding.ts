/**
 * An assertion is only good for the endpoint it was minted for, and a replay
 * is deduplicated on something the IdP signed. Written once for both planes.
 *
 * There are two SAML Assertion Consumer Services in this app — the workspace
 * one at `/api/t/<slug>/auth/saml/<provider>/acs` (`routes/tenant-auth.ts`) and
 * the platform one at `/api/auth/saml/<provider>/acs`
 * (`routes/platform-auth.ts`). They had byte-identical replay code and the
 * identical defect, which is the same shape `services/membership-guards.ts`
 * exists to prevent: two implementations of one invariant drift, and the drift
 * is silent because each plane's tests only exercise its own copy.
 *
 * WHAT WAS WRONG
 *
 * Both keyed the replay row on `assertion.id`, which the contract documented
 * as the AssertionID and the adapter filled from the `<samlp:Response>`
 * envelope. Default provider config is
 * `wantSignedAssertions: true` (`services/saml-providers.ts`), so only the
 * `<Assertion>` is signed — the envelope and its `@ID` are not. Measured
 * against the real app: POST a valid signed response, get a session; POST the
 * exact same bytes, get `401 SAML assertion replay detected`; change the one
 * unsigned attribute `Response/@ID` and POST again — `302` with a second live
 * `app_sessions` row. Anyone who can observe one assertion in flight (a proxy,
 * a browser extension, a referrer leak, a shared terminal) could re-use it
 * until `NotOnOrAfter`, as many times as they liked.
 */
import { AppError } from "@backlex/core";
import type { SamlAssertion } from "@backlex/core/adapters";

/**
 * Compare two absolute URLs the way an SP and an IdP admin would consider them
 * "the same endpoint".
 *
 * Scheme and host are case-insensitive per RFC 3986 and a default port is
 * equivalent to no port, so an IdP configured with `HTTPS://SSO.Example.com/…`
 * must not lock a workspace out of its own login. The path is compared
 * exactly apart from a trailing slash: it is the part that selects WHICH
 * provider's ACS this is, and folding case there would let
 * `/auth/saml/okta/acs` satisfy a check meant for `/auth/saml/OKTA/acs` on a
 * case-sensitive router.
 */
const sameEndpoint = (a: string, b: string): boolean => {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const path = (u: URL) => (u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname);
    return (
      ua.protocol === ub.protocol &&
      ua.host.toLowerCase() === ub.host.toLowerCase() &&
      path(ua) === path(ub)
    );
  } catch {
    return false;
  }
};

/**
 * Refuse an assertion that names a different Assertion Consumer Service.
 *
 * `Recipient` lives in `<SubjectConfirmationData>`, INSIDE the signed
 * assertion, so this is a real control: an assertion captured at one SP cannot
 * be posted to another, and an attacker cannot strip the attribute without
 * invalidating the signature. `Destination` sits on the unsigned envelope, so
 * a mismatch there says "misconfigured", not "attack" — it is checked because
 * a wrong `Destination` is a genuine deployment bug worth naming early, and it
 * is checked SECOND so the message a real attack produces is the signed one.
 *
 * Both are enforced only when the IdP sent them. That is deliberate and it is
 * safe for the signed one for the reason above; for `Destination` it is merely
 * honest about what an optional unsigned field can be worth. Making either
 * mandatory would refuse IdPs that omit them today, which is a lockout, not a
 * fix.
 */
export const assertAssertionBoundToAcs = (
  assertion: Pick<SamlAssertion, "recipient" | "destination">,
  acsUrl: string,
): void => {
  if (assertion.recipient && !sameEndpoint(assertion.recipient, acsUrl)) {
    throw new AppError(
      "UNAUTHORIZED",
      "SAML assertion was issued for a different Assertion Consumer Service",
    );
  }
  if (assertion.destination && !sameEndpoint(assertion.destination, acsUrl)) {
    throw new AppError(
      "UNAUTHORIZED",
      "SAML response Destination does not match this Assertion Consumer Service",
    );
  }
};

/**
 * The value a replay row is keyed on.
 *
 * Exists so neither plane can reach for `responseId` again by habit, and so
 * the reason lives next to the value rather than in a comment on one of the
 * two call sites.
 *
 * Existing rows written under the old key are not migrated and do not need to
 * be: they carry an expiry of the assertion's own `NotOnOrAfter` (minutes),
 * `findVerification` matches on the exact identifier string, and a stale
 * `saml-assertion:<responseId>` row can only collide with a future
 * `saml-assertion:<assertionId>` if an IdP reuses one document's Response `@ID`
 * as another document's Assertion `@ID` — both are `xs:ID` values it generates
 * fresh per response. The worst case of a collision is one refused login that
 * succeeds on retry, which is the safe direction.
 */
export const samlReplayIdentity = (assertion: Pick<SamlAssertion, "assertionId">): string =>
  assertion.assertionId;
