/**
 * Regression gates for the 2026-09 pre-production audit, phase 6:
 * **a SAML replay is deduplicated on something the IdP actually signed.**
 *
 * Default provider config is `wantSignedAssertions: true`, so the signature
 * covers the `<saml2:Assertion>` and NOT the `<samlp:Response>` envelope that
 * carries it. Both Assertion Consumer Services keyed their replay row on
 * `assertion.id`, and the adapter filled that from the envelope's `@ID` —
 * `Extractor.loginResponseFields` has no Assertion-ID field at all, only
 * `localPath: ['Response']` read from the whole document.
 *
 * Measured against the real app before the fix, on the workspace ACS:
 *
 *   POST a valid signed response          → 302, session minted
 *   POST the identical bytes again        → 401 "SAML assertion replay detected"
 *   change ONE unsigned byte — the outer
 *   `Response/@ID` — and POST again       → 302, a SECOND session minted
 *
 * `app_sessions` held two rows for one signed assertion. Anyone who observed a
 * single assertion in flight could re-use it until `NotOnOrAfter`, as often as
 * they liked, and the guard reported success every time because every replay
 * presented a key it had never seen.
 *
 * The existing `saml.test.ts` / `platform-saml.test.ts` replay tests re-POST
 * IDENTICAL bytes, so they passed under the old behaviour and under the new
 * one. That is the hole this file fills: the only test that can tell the two
 * apart is the one that mutates the envelope and leaves the signature intact.
 *
 * The second half of the file is the `Recipient` binding — an assertion minted
 * for one ACS must not be accepted at another. `Recipient` lives inside
 * `<SubjectConfirmationData>`, i.e. inside the signed scope, so unlike
 * `Destination` it cannot be edited away.
 *
 * BOTH planes are here. `routes/platform-auth.ts` is a copy of
 * `routes/tenant-auth.ts` and had the identical defect on the plane that
 * administers the instance; the audit named only the workspace one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import forge from "node-forge";
import { SignedXml } from "xml-crypto";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

interface Keypair {
  privateKey: string;
  certPem: string;
  certBody: string;
}

const buildKeypair = (): Keypair => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const pki = forge.pki;
  const cert = pki.createCertificate();
  cert.publicKey = pki.publicKeyFromPem(publicKey);
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  cert.setSubject([{ name: "commonName", value: "backlex-faz6" }]);
  cert.setIssuer([{ name: "commonName", value: "backlex-faz6" }]);
  cert.sign(pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  const certPem = pki.certificateToPem(cert);
  return {
    privateKey,
    certPem,
    certBody: certPem.replace(
      /-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g,
      "",
    ),
  };
};

const APP_URL = "http://localhost:5173";

interface FixtureArgs {
  kp: Keypair;
  issuer: string;
  audience: string;
  /** `SubjectConfirmationData/@Recipient` — inside the signed scope. */
  recipient: string;
  /** `Response/@Destination` — outside it. Defaults to `recipient`. */
  destination?: string;
  responseId: string;
  assertionId: string;
  email?: string;
}

/**
 * Returns the SIGNED XML, not base64, so a test can edit the envelope and
 * re-encode. That is the entire point of this file: a replay that re-POSTs
 * identical bytes proves nothing about WHICH id the row was keyed on.
 */
const signResponseXml = (args: FixtureArgs): string => {
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000).toISOString();
  const notOnOrAfter = new Date(now.getTime() + 5 * 60_000).toISOString();
  const issueInstant = now.toISOString();
  const email = args.email ?? "alice@example.com";
  const destination = args.destination ?? args.recipient;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<saml2p:Response xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" Destination="${destination}" ID="${args.responseId}" IssueInstant="${issueInstant}" Version="2.0">
  <saml2:Issuer>${args.issuer}</saml2:Issuer>
  <saml2p:Status><saml2p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></saml2p:Status>
  <saml2:Assertion ID="${args.assertionId}" IssueInstant="${issueInstant}" Version="2.0">
    <saml2:Issuer>${args.issuer}</saml2:Issuer>
    <saml2:Subject>
      <saml2:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml2:NameID>
      <saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml2:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${args.recipient}"/>
      </saml2:SubjectConfirmation>
    </saml2:Subject>
    <saml2:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
      <saml2:AudienceRestriction><saml2:Audience>${args.audience}</saml2:Audience></saml2:AudienceRestriction>
    </saml2:Conditions>
    <saml2:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="_sess-fixed">
      <saml2:AuthnContext><saml2:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml2:AuthnContextClassRef></saml2:AuthnContext>
    </saml2:AuthnStatement>
    <saml2:AttributeStatement>
      <saml2:Attribute Name="email"><saml2:AttributeValue>${email}</saml2:AttributeValue></saml2:Attribute>
    </saml2:AttributeStatement>
  </saml2:Assertion>
</saml2p:Response>`;

  const sig = new SignedXml({ privateKey: args.kp.privateKey });
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
    `<X509Data><X509Certificate>${args.kp.certBody}</X509Certificate></X509Data>`;
  sig.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='Assertion']`, action: "append" },
  });
  return sig.getSignedXml();
};

const b64 = (xml: string): string => Buffer.from(xml).toString("base64");

/** Swap the outer `Response/@ID` and nothing else. The value appears exactly
 *  once — `SessionIndex` is a different attribute name and the Assertion ID
 *  differs — and the assertion's signature is untouched. */
const mutateEnvelopeId = (signedXml: string, from: string, to: string): string => {
  const before = `ID="${from}"`;
  const occurrences = signedXml.split(before).length - 1;
  expect(occurrences, "the envelope id appears exactly once").toBe(1);
  return signedXml.replace(before, `ID="${to}"`);
};

const sessionCount = (h: TestHarness, table: string): number => {
  const db = new Database(h.env.SQLITE_PATH ?? "", { readonly: true });
  try {
    const rows = db.query(`SELECT COUNT(*) AS n FROM ${table}`).all() as { n: number }[];
    return rows[0]?.n ?? 0;
  } finally {
    db.close();
  }
};

const errorOf = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  return body.error?.message ?? "";
};

// ---------------------------------------------------------------------------
// Workspace plane
// ---------------------------------------------------------------------------

describe("faz6: workspace SAML — a replay survives an envelope edit no longer", () => {
  const IDP_ENTITY_ID = "https://idp.example/faz6-tenant";
  const SLUG = "default";
  const ACS_URL = `${APP_URL}/api/t/${SLUG}/auth/saml/faz6-idp/acs`;
  const SP_ENTITY_ID = `${APP_URL}/api/t/${SLUG}/auth/saml/faz6-idp/metadata`;

  let h: TestHarness;
  let kp: Keypair;

  const post = (xml: string) => {
    const form = new URLSearchParams();
    form.set("SAMLResponse", b64(xml));
    return h.fetch(`/api/t/${SLUG}/auth/saml/faz6-idp/acs`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
  };

  const sign = (over: Partial<FixtureArgs> & Pick<FixtureArgs, "responseId" | "assertionId">) =>
    signResponseXml({
      kp,
      issuer: IDP_ENTITY_ID,
      audience: SP_ENTITY_ID,
      recipient: ACS_URL,
      ...over,
    });

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    kp = buildKeypair();
    const res = await h.fetch("/api/admin/saml/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Faz6 IdP",
        slug: "faz6-idp",
        entityId: IDP_ENTITY_ID,
        ssoUrl: `${IDP_ENTITY_ID}/sso`,
        idpCertPem: kp.certPem,
        spEntityId: SP_ENTITY_ID,
        attributeMap: { email: "email" },
      }),
    });
    if (!res.ok) throw new Error(`provider: ${res.status} ${await res.text()}`);
  });
  afterAll(() => h.cleanup());

  test("editing only the unsigned Response @ID does not buy a second session", async () => {
    const signed = sign({ responseId: "_resp-A", assertionId: "_assn-FIXED" });

    const first = await post(signed);
    expect(first.status, "a genuine assertion signs the user in").toBe(302);
    expect(first.headers.get("location") ?? "").toContain("#token=");
    const afterFirst = sessionCount(h, "app_sessions");
    expect(afterFirst, "one session for one assertion").toBe(1);

    const identical = await post(signed);
    expect(identical.status, "the identical bytes, again").toBe(401);
    expect(await errorOf(identical)).toContain("replay");

    // THE test. One attribute, outside the signature, everything else byte for
    // byte the same. This took a 302 and minted a second session.
    const mutated = mutateEnvelopeId(signed, "_resp-A", "_resp-B");
    expect(mutated).not.toBe(signed);
    expect(mutated).toContain('ID="_assn-FIXED"');
    const replay = await post(mutated);
    expect(replay.status, "same signed assertion, new envelope id").toBe(401);
    expect(await errorOf(replay)).toContain("replay");

    // `silent success is the house bug`: assert the absence of the effect, not
    // just the status code.
    expect(sessionCount(h, "app_sessions"), "still one session").toBe(afterFirst);
  });

  test("a genuinely new assertion is still accepted (the control)", async () => {
    // Without this, a guard that refused EVERY assertion would pass the block
    // above and nobody could sign in at all.
    const fresh = sign({ responseId: "_resp-C", assertionId: "_assn-SECOND" });
    const res = await post(fresh);
    expect(res.status, "a second, distinct assertion").toBe(302);
    expect(res.headers.get("location") ?? "").toContain("#token=");
  });

  test("an assertion minted for another ACS is refused", async () => {
    // `Recipient` is signed, so this is a real control rather than a hint: an
    // attacker cannot strip or edit it without breaking the signature.
    const elsewhere = sign({
      responseId: "_resp-D",
      assertionId: "_assn-ELSEWHERE",
      recipient: `${APP_URL}/api/t/other/auth/saml/faz6-idp/acs`,
    });
    const res = await post(elsewhere);
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toContain("different Assertion Consumer Service");
  });

  test("a Destination naming another ACS is refused as defence in depth", async () => {
    const wrongDest = sign({
      responseId: "_resp-E",
      assertionId: "_assn-DEST",
      destination: `${APP_URL}/api/t/other/auth/saml/faz6-idp/acs`,
    });
    const res = await post(wrongDest);
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toContain("Destination");
  });

  test("a trailing slash or a capitalised host is not a lockout", async () => {
    // The signed check has to be strict about WHICH provider's ACS this is and
    // relaxed about the things RFC 3986 says are the same URL, or an IdP
    // configured with a capitalised host locks a workspace out of its own
    // login.
    const url = new URL(ACS_URL);
    const shouty = `${url.protocol}//${url.host.toUpperCase()}${url.pathname}/`;
    const res = await post(
      sign({ responseId: "_resp-F", assertionId: "_assn-CASE", recipient: shouty }),
    );
    expect(res.status, "same endpoint, noisier spelling").toBe(302);
  });
});

// ---------------------------------------------------------------------------
// Platform plane — the copy the audit did not name
// ---------------------------------------------------------------------------

describe("faz6: platform SAML — the same defect on the instance-admin plane", () => {
  const IDP_ENTITY_ID = "https://idp.example/faz6-platform";
  const ACS_URL = `${APP_URL}/api/auth/saml/faz6-admin/acs`;
  const SP_ENTITY_ID = `${APP_URL}/api/auth/saml/faz6-admin/metadata`;

  let h: TestHarness;
  let kp: Keypair;

  const post = (xml: string) => {
    const form = new URLSearchParams();
    form.set("SAMLResponse", b64(xml));
    return h.fetch("/api/auth/saml/faz6-admin/acs", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    kp = buildKeypair();
    const res = await h.fetch("/api/admin/platform-saml/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Faz6 Admin IdP",
        slug: "faz6-admin",
        entityId: IDP_ENTITY_ID,
        ssoUrl: `${IDP_ENTITY_ID}/sso`,
        idpCertPem: kp.certPem,
        spEntityId: SP_ENTITY_ID,
        attributeMap: { email: "email" },
      }),
    });
    if (!res.ok) throw new Error(`platform provider: ${res.status} ${await res.text()}`);
  });
  afterAll(() => h.cleanup());

  test("editing only the unsigned Response @ID does not re-admit an operator", async () => {
    const signed = signResponseXml({
      kp,
      issuer: IDP_ENTITY_ID,
      audience: SP_ENTITY_ID,
      recipient: ACS_URL,
      responseId: "_presp-A",
      assertionId: "_passn-FIXED",
      email: "operator@example.com",
    });

    expect((await post(signed)).status, "a genuine assertion").toBe(302);
    expect((await post(signed)).status, "identical bytes").toBe(401);

    const mutated = mutateEnvelopeId(signed, "_presp-A", "_presp-B");
    const replay = await post(mutated);
    expect(replay.status, "same signed assertion, new envelope id").toBe(401);
    expect(await errorOf(replay)).toContain("replay");
  });

  test("an assertion minted for another ACS is refused here too", async () => {
    const res = await post(
      signResponseXml({
        kp,
        issuer: IDP_ENTITY_ID,
        audience: SP_ENTITY_ID,
        recipient: `${APP_URL}/api/auth/saml/somewhere-else/acs`,
        responseId: "_presp-C",
        assertionId: "_passn-ELSEWHERE",
        email: "operator@example.com",
      }),
    );
    expect(res.status).toBe(401);
    expect(await errorOf(res)).toContain("different Assertion Consumer Service");
  });
});
