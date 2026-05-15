/**
 * SAML 2.0 service-provider adapter contract.
 *
 * The workspace acts as the SP — it accepts SAMLResponse POSTs from a
 * customer-configured IdP at `/api/t/<slug>/auth/saml/<provider-slug>/acs`.
 *
 * The adapter is intentionally stateless and runtime-agnostic. All
 * mutation (replay tables, app_sessions, app_users provisioning) happens
 * outside the adapter, in the route layer. Storage of the cert PEM,
 * decryption of `enc:v1:...` ciphertext, and config caching are likewise
 * the responsibility of the caller. The adapter only:
 *
 *   - builds an AuthnRequest URL for SP-initiated login;
 *   - parses + verifies an IdP-asserted SAMLResponse and extracts attributes;
 *   - builds an SP-initiated LogoutRequest URL;
 *   - emits the SP's SAML metadata XML for IdP-side configuration.
 */

/**
 * Per-provider configuration handed to the adapter on every call. The route
 * layer assembles this from a (decrypted) `saml_providers` row.
 */
export interface SamlProviderConfig {
  /** Provider's database id. Surfaced for logging only. */
  id: string;
  /** IdP issuer (`<saml2:Issuer>` value). */
  entityId: string;
  /** Where the SP redirects users to start the AuthnRequest. */
  ssoUrl: string;
  /** Optional IdP SLO endpoint. When absent SLO is local-only. */
  sloUrl?: string;
  /** IdP signing cert PEM (already decrypted). */
  idpCertPem: string;
  /** SP entity id — typically the SP metadata URL. */
  spEntityId: string;
  /** Public ACS endpoint for this provider (absolute URL). */
  acsUrl: string;
  /** Optional SLO endpoint for IdP-initiated logout requests. */
  sloAcsUrl?: string;
  /** rsa-sha1 | rsa-sha256 | rsa-sha512 — defaults to sha256 if absent. */
  signatureAlgorithm?: "sha1" | "sha256" | "sha512";
  /** When true, the adapter rejects responses whose Assertion isn't signed. */
  wantSignedAssertions: boolean;
  /** NameID format the SP requests in AuthnRequest. */
  nameIdFormat: string;
  /** Maps assertion attribute names → canonical workeros user fields.
   *  Keys expected: `email`, `firstName`, `lastName`, `groups`. */
  attributeMap: Record<string, string>;
}

/**
 * Output of a verified SAML Response. The route layer is responsible for
 * passing this into provisioning (see services/sso-provisioning.ts) — the
 * adapter doesn't touch the database.
 */
export interface SamlAssertion {
  /** AssertionID — used for replay protection. */
  id: string;
  /** IdP issuer that signed the assertion (verified). */
  issuer: string;
  /** SAML NameID — the stable IdP-side subject. */
  nameId: string;
  /** Optional NameIDFormat the IdP issued. */
  nameIdFormat?: string;
  /** AudienceRestriction value — typically the SP entity id. */
  audience: string;
  /** Top-level Response InResponseTo (the request id the SP sent), when
   *  present. SP-initiated flow only — IdP-initiated responses have none. */
  inResponseTo?: string;
  /** Conditions.NotOnOrAfter (or SubjectConfirmationData.NotOnOrAfter when
   *  more restrictive). Used to bound the replay-protection row's lifetime. */
  notOnOrAfter: Date;
  /** AuthnStatement SessionIndex — needed for SLO. */
  sessionIndex?: string;
  /** AuthnContextClassRef — surfaced for audit/admin diagnostics. */
  authnContext?: string;
  /** Decoded attribute statement: { "<attribute name>": ["<value>", ...] }.
   *  Multi-valued attributes (e.g. groups) carry every value. */
  attributes: Record<string, string[]>;
}

export interface SamlAuthnRequest {
  /** Full redirect URL to send the user to. */
  url: string;
  /** Request id — the route layer persists this in `app_verifications` for
   *  the ACS handler to match against `inResponseTo` (replay + correlation). */
  requestId: string;
}

export interface SamlLogoutRequest {
  /** Full redirect URL to send the user to (IdP SLO endpoint). */
  url: string;
}

export interface SamlAdapter {
  /**
   * Build a SAML AuthnRequest URL (HTTP-Redirect binding) that points the
   * user-agent at the IdP's SSO endpoint. RelayState is opaque to the IdP
   * and is echoed back to the ACS — use it to ferry the post-login
   * destination URL.
   */
  buildAuthnRequest(
    cfg: SamlProviderConfig,
    options: { relayState?: string },
  ): Promise<SamlAuthnRequest>;

  /**
   * Parse and verify a SAML Response (HTTP-POST binding). Throws on bad
   * signature, bad issuer, expired NotOnOrAfter, audience mismatch, or any
   * other validation failure. Returns the assertion attributes on success.
   *
   * `samlResponseB64` is the raw base64 form-field value the IdP POSTs to
   * the SP's ACS endpoint.
   */
  verifyAssertion(
    cfg: SamlProviderConfig,
    samlResponseB64: string,
  ): Promise<SamlAssertion>;

  /**
   * Build a SAML LogoutRequest URL to terminate an IdP session for the
   * given subject. Returns `null` if the provider has no SLO URL configured.
   */
  buildLogoutRequest(
    cfg: SamlProviderConfig,
    args: { nameId: string; sessionIndex?: string },
  ): Promise<SamlLogoutRequest | null>;

  /**
   * Render this SP's SAML metadata XML (for the IdP admin to upload/
   * configure). Includes the ACS URL, SP entity id, and the binding list.
   */
  metadataXml(cfg: SamlProviderConfig): string;
}
