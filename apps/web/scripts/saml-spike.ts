/**
 * Phase 1 SAML spike — exercises `samlify` end-to-end with a self-signed
 * IdP fixture and confirms `parseLoginResponse` can verify the resulting
 * signed SAML Response. Run with:
 *
 *   bun run apps/web/scripts/saml-spike.ts
 *
 * The script is also the reference fixture pattern used by
 * `apps/web/tests/saml.test.ts`. It generates an RSA keypair on the fly,
 * signs an Assertion with `xml-crypto` (samlify's signing dep), embeds it
 * in a SAML Response, then verifies the Response via samlify's
 * `ServiceProvider.parseLoginResponse`.
 *
 * Workers compatibility: samlify and xml-crypto both import from
 * `node:crypto`. Cloudflare Workers expose those under the
 * `nodejs_compat` flag (apps/web/wrangler.toml: compatibility_date
 * `2025-01-01` + `compatibility_flags = ["nodejs_compat"]`). The adapter
 * (`apps/web/src/server/adapters/saml.samlify.ts`) is therefore expected
 * to load on Workers. If a future Workers runtime drops a primitive that
 * samlify needs, swap in the Web-Crypto-based verifier per the plan.
 */
import { generateKeyPairSync, createPrivateKey, X509Certificate } from "node:crypto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as samlifyNs from "samlify";
import { SignedXml } from "xml-crypto";
import * as forge from "node-forge";

// `samlify` ships as CJS; pull the namespace defensively so we work regardless
// of how Bun resolves `* as` imports.
const samlify = (samlifyNs as { default?: typeof samlifyNs } & typeof samlifyNs).default ?? samlifyNs;

// samlify requires a schema validator. The default expects libxml2; for the
// spike we install a noop validator (signature verification is enforced
// separately, and our fixtures are well-formed).
samlify.setSchemaValidator({
  validate: async () => "skipped",
});

const SP_ENTITY_ID = "https://workeros.example/api/t/acme/saml/okta/metadata";
const SP_ACS_URL = "https://workeros.example/api/t/acme/auth/saml/okta/acs";
const IDP_ENTITY_ID = "https://idp.example/saml";
const IDP_SSO_URL = "https://idp.example/saml/sso";

// 1. Generate an RSA keypair for the fake IdP.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// 2. Build a self-signed X.509 cert from the keypair. samlify wants a real
//    cert PEM as `signingCert`; the public key alone won't pass its checks.
const buildSelfSignedCert = (): string => {
  const pki = forge.pki;
  const fwdPrivate = pki.privateKeyFromPem(privateKey);
  const fwdPublic = pki.publicKeyFromPem(publicKey);
  const cert = pki.createCertificate();
  cert.publicKey = fwdPublic;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: "commonName", value: "workeros-saml-spike" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(fwdPrivate, forge.md.sha256.create());
  return pki.certificateToPem(cert);
};

const cert = buildSelfSignedCert();
console.log("[spike] Generated self-signed cert (length:", cert.length, ")");

// 3. Build the IdP fixture (samlify-side).
const idp = samlify.IdentityProvider({
  entityID: IDP_ENTITY_ID,
  singleSignOnService: [
    { Binding: samlify.Constants.namespace.binding.redirect, Location: IDP_SSO_URL },
  ],
  privateKey,
  signingCert: cert,
  isAssertionEncrypted: false,
});

// 4. SP fixture (the workeros side).
const sp = samlify.ServiceProvider({
  entityID: SP_ENTITY_ID,
  assertionConsumerService: [
    { Binding: samlify.Constants.namespace.binding.post, Location: SP_ACS_URL, isDefault: true },
  ],
  wantAssertionsSigned: true,
  signingCert: cert,
});

console.log("[spike] SP entityID:", SP_ENTITY_ID);
console.log("[spike] IdP entityID:", IDP_ENTITY_ID);

// 5. SP creates the AuthnRequest.
const loginReq = sp.createLoginRequest(idp, "redirect");
console.log(
  "[spike] AuthnRequest URL (truncated):",
  "context" in loginReq ? loginReq.context.slice(0, 120) + "…" : "(no context)",
);

// 6. Build a Response with one signed Assertion.
const responseId = `_${Math.random().toString(36).slice(2)}`;
const assertionId = `_${Math.random().toString(36).slice(2)}`;
const now = new Date();
const notBefore = new Date(now.getTime() - 60_000).toISOString();
const notOnOrAfter = new Date(now.getTime() + 5 * 60_000).toISOString();
const issueInstant = now.toISOString();

const certBody = cert.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, "");

const responseXml = `<?xml version="1.0" encoding="UTF-8"?>
<saml2p:Response xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" Destination="${SP_ACS_URL}" ID="${responseId}" IssueInstant="${issueInstant}" Version="2.0">
  <saml2:Issuer>${IDP_ENTITY_ID}</saml2:Issuer>
  <saml2p:Status><saml2p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></saml2p:Status>
  <saml2:Assertion ID="${assertionId}" IssueInstant="${issueInstant}" Version="2.0">
    <saml2:Issuer>${IDP_ENTITY_ID}</saml2:Issuer>
    <saml2:Subject>
      <saml2:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@example.com</saml2:NameID>
      <saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml2:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${SP_ACS_URL}"/>
      </saml2:SubjectConfirmation>
    </saml2:Subject>
    <saml2:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
      <saml2:AudienceRestriction><saml2:Audience>${SP_ENTITY_ID}</saml2:Audience></saml2:AudienceRestriction>
    </saml2:Conditions>
    <saml2:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="${responseId}">
      <saml2:AuthnContext><saml2:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml2:AuthnContextClassRef></saml2:AuthnContext>
    </saml2:AuthnStatement>
    <saml2:AttributeStatement>
      <saml2:Attribute Name="email"><saml2:AttributeValue>alice@example.com</saml2:AttributeValue></saml2:Attribute>
      <saml2:Attribute Name="firstName"><saml2:AttributeValue>Alice</saml2:AttributeValue></saml2:Attribute>
      <saml2:Attribute Name="lastName"><saml2:AttributeValue>Doe</saml2:AttributeValue></saml2:Attribute>
    </saml2:AttributeStatement>
  </saml2:Assertion>
</saml2p:Response>`;

// 7. Sign the Assertion with xml-crypto.
const sig = new SignedXml({ privateKey });
sig.addReference({
  xpath: `//*[local-name(.)='Assertion']`,
  transforms: [
    "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
    "http://www.w3.org/2001/10/xml-exc-c14n#",
  ],
  digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
});
sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
sig.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
sig.getKeyInfoContent = () =>
  `<X509Data><X509Certificate>${certBody}</X509Certificate></X509Data>`;

sig.computeSignature(responseXml, {
  location: { reference: `//*[local-name(.)='Assertion']`, action: "append" },
});
const signedXml = sig.getSignedXml();

const base64 = Buffer.from(signedXml).toString("base64");
console.log("[spike] Signed response length:", signedXml.length);

// 8. SP verifies.
try {
  const result = await sp.parseLoginResponse(idp, "post", {
    body: { SAMLResponse: base64 },
  });
  console.log("[spike] OK — verified");
  console.log("[spike] NameID:", (result.extract as { nameID?: unknown }).nameID);
  console.log(
    "[spike] Attributes:",
    JSON.stringify((result.extract as { attributes?: unknown }).attributes, null, 2),
  );
  console.log("[spike] PASS — samlify works under Bun");
} catch (err) {
  console.error("[spike] FAIL — parseLoginResponse rejected the response:", err);
  process.exit(1);
}
