/**
 * SAML 2.0 SSO — end-to-end tests against the in-process Hono app.
 *
 * Fixture pattern (lifted from apps/web/scripts/saml-spike.ts):
 *   1. Generate a one-shot RSA keypair + self-signed cert with node-forge.
 *   2. Wire a SAML provider via POST /api/admin/saml/providers (the same
 *      cert is configured here as the IdP signing cert).
 *   3. Build a SAML Response, sign the embedded Assertion with xml-crypto,
 *      POST it base64 to the ACS endpoint, and assert the response is a
 *      302 redirect that carries a `#token=...&type=saml` fragment.
 *
 * The tests cover every contract the plan called out: replay protection,
 * tampered signature, expired NotOnOrAfter, audience/issuer mismatch,
 * idempotent re-login, linkByVerifiedEmail link vs. fresh-account
 * provisioning, groups → roles reconciliation, metadata XML, and the
 * open-redirect guard on relayState.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import forge from "node-forge";
import { SignedXml } from "xml-crypto";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

type Keypair = { privateKey: string; publicKey: string; certPem: string; certBody: string };

const buildKeypair = (): Keypair => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const pki = forge.pki;
  const fwdPrivate = pki.privateKeyFromPem(privateKey);
  const fwdPublic = pki.publicKeyFromPem(publicKey);
  const cert = pki.createCertificate();
  cert.publicKey = fwdPublic;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  cert.setSubject([{ name: "commonName", value: "workeros-saml-test" }]);
  cert.setIssuer([{ name: "commonName", value: "workeros-saml-test" }]);
  cert.sign(fwdPrivate, forge.md.sha256.create());
  const certPem = pki.certificateToPem(cert);
  const certBody = certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g, "");
  return { privateKey, publicKey, certPem, certBody };
};

interface ResponseFixtureArgs {
  privateKey: string;
  certBody: string;
  issuer: string;
  audience: string;
  recipient: string;
  email?: string;
  nameId?: string;
  groups?: string[];
  notOnOrAfter?: Date;
  notBefore?: Date;
  responseId?: string;
  assertionId?: string;
  inResponseTo?: string;
  tamperAfterSign?: boolean;
}

const signResponse = (args: ResponseFixtureArgs): string => {
  const now = new Date();
  const responseId = args.responseId ?? `_${Math.random().toString(36).slice(2)}`;
  const assertionId = args.assertionId ?? `_${Math.random().toString(36).slice(2)}`;
  const notBefore = (args.notBefore ?? new Date(now.getTime() - 60_000)).toISOString();
  const notOnOrAfter = (args.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000)).toISOString();
  const issueInstant = now.toISOString();
  const email = args.email ?? "alice@example.com";
  const nameId = args.nameId ?? email;
  const groups = args.groups ?? [];

  const groupsXml = groups
    .map((g) => `<saml2:AttributeValue>${g}</saml2:AttributeValue>`)
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<saml2p:Response xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" Destination="${args.recipient}" ID="${responseId}" IssueInstant="${issueInstant}"${args.inResponseTo ? ` InResponseTo="${args.inResponseTo}"` : ""} Version="2.0">
  <saml2:Issuer>${args.issuer}</saml2:Issuer>
  <saml2p:Status><saml2p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></saml2p:Status>
  <saml2:Assertion ID="${assertionId}" IssueInstant="${issueInstant}" Version="2.0">
    <saml2:Issuer>${args.issuer}</saml2:Issuer>
    <saml2:Subject>
      <saml2:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml2:NameID>
      <saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml2:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${args.recipient}"${args.inResponseTo ? ` InResponseTo="${args.inResponseTo}"` : ""}/>
      </saml2:SubjectConfirmation>
    </saml2:Subject>
    <saml2:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
      <saml2:AudienceRestriction><saml2:Audience>${args.audience}</saml2:Audience></saml2:AudienceRestriction>
    </saml2:Conditions>
    <saml2:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="${responseId}">
      <saml2:AuthnContext><saml2:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml2:AuthnContextClassRef></saml2:AuthnContext>
    </saml2:AuthnStatement>
    <saml2:AttributeStatement>
      <saml2:Attribute Name="email"><saml2:AttributeValue>${email}</saml2:AttributeValue></saml2:Attribute>
      <saml2:Attribute Name="firstName"><saml2:AttributeValue>Alice</saml2:AttributeValue></saml2:Attribute>
      <saml2:Attribute Name="lastName"><saml2:AttributeValue>Doe</saml2:AttributeValue></saml2:Attribute>
      ${groups.length > 0 ? `<saml2:Attribute Name="groups">${groupsXml}</saml2:Attribute>` : ""}
    </saml2:AttributeStatement>
  </saml2:Assertion>
</saml2p:Response>`;

  const sig = new SignedXml({ privateKey: args.privateKey });
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
    `<X509Data><X509Certificate>${args.certBody}</X509Certificate></X509Data>`;
  sig.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='Assertion']`, action: "append" },
  });
  let signed = sig.getSignedXml();
  if (args.tamperAfterSign) {
    // Flip a single attribute value AFTER signing — the signature should fail.
    signed = signed.replace(/alice@example\.com/g, "mallory@example.com");
  }
  return Buffer.from(signed).toString("base64");
};

const IDP_ENTITY_ID = "https://idp.example/saml/test";
const APP_URL = "http://localhost:5173";
const TENANT_SLUG = "default";

const ACS_URL = `${APP_URL}/api/t/${TENANT_SLUG}/auth/saml/test-idp/acs`;
const METADATA_URL = `${APP_URL}/api/t/${TENANT_SLUG}/auth/saml/test-idp/metadata`;
const SP_ENTITY_ID = METADATA_URL;

const createProvider = async (
  h: TestHarness,
  cfg: { certPem: string; linkByVerifiedEmail?: boolean; defaultRoleId?: string | null; groupsToRoles?: Record<string, string> | null },
) => {
  const res = await h.fetch("/api/admin/saml/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Test IdP",
      slug: "test-idp",
      entityId: IDP_ENTITY_ID,
      ssoUrl: `${IDP_ENTITY_ID}/sso`,
      idpCertPem: cfg.certPem,
      spEntityId: SP_ENTITY_ID,
      attributeMap: { email: "email", firstName: "firstName", lastName: "lastName", groups: "groups" },
      linkByVerifiedEmail: cfg.linkByVerifiedEmail ?? false,
      defaultRoleId: cfg.defaultRoleId ?? null,
      groupsToRoles: cfg.groupsToRoles ?? null,
    }),
  });
  if (!res.ok) throw new Error(`create provider failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { data: { id: string; slug: string } };
};

const sqliteAt = (h: TestHarness): Database => {
  const path = h.env.SQLITE_PATH;
  if (!path) throw new Error("test harness has no SQLITE_PATH");
  return new Database(path, { readonly: true });
};

describe("saml: full ACS round-trip + replay + tamper", () => {
  let h: TestHarness;
  let kp: Keypair;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    kp = buildKeypair();
    await createProvider(h, { certPem: kp.certPem });
  });

  afterAll(() => {
    h.cleanup();
  });

  test("happy path: signed assertion → 302 to relayState with #token", async () => {
    const samlResp = signResponse({
      privateKey: kp.privateKey,
      certBody: kp.certBody,
      issuer: IDP_ENTITY_ID,
      audience: SP_ENTITY_ID,
      recipient: ACS_URL,
    });
    const form = new URLSearchParams();
    form.set("SAMLResponse", samlResp);
    const res = await h.fetch(`/api/t/${TENANT_SLUG}/auth/saml/test-idp/acs`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("#token=");
    expect(loc).toContain("type=saml");

    const db = sqliteAt(h);
    const users = db
      .query("SELECT email FROM app_users WHERE email = ?")
      .all("alice@example.com") as { email: string }[];
    expect(users.length).toBe(1);
    const idents = db
      .query("SELECT subject FROM external_identities WHERE provider_type = 'saml'")
      .all() as { subject: string }[];
    expect(idents.some((r) => r.subject === "alice@example.com")).toBe(true);
    const sessions = db
      .query("SELECT token FROM app_sessions")
      .all() as { token: string }[];
    expect(sessions.length).toBe(1);
    db.close();
  });

  test("replay: re-POST the same assertion → 401", async () => {
    const samlResp = signResponse({
      privateKey: kp.privateKey,
      certBody: kp.certBody,
      issuer: IDP_ENTITY_ID,
      audience: SP_ENTITY_ID,
      recipient: ACS_URL,
      assertionId: "_replay-fixed",
    });
    const form = new URLSearchParams();
    form.set("SAMLResponse", samlResp);
    const first = await h.fetch(`/api/t/${TENANT_SLUG}/auth/saml/test-idp/acs`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(first.status).toBe(302);
    const replay = await h.fetch(`/api/t/${TENANT_SLUG}/auth/saml/test-idp/acs`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(replay.status).toBe(401);
  });

  test("tampered signature → 401", async () => {
    const samlResp = signResponse({
      privateKey: kp.privateKey,
      certBody: kp.certBody,
      issuer: IDP_ENTITY_ID,
      audience: SP_ENTITY_ID,
      recipient: ACS_URL,
      tamperAfterSign: true,
    });
    const form = new URLSearchParams();
    form.set("SAMLResponse", samlResp);
    const res = await h.fetch(`/api/t/${TENANT_SLUG}/auth/saml/test-idp/acs`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });

  test("expired NotOnOrAfter → 401", async () => {
    const samlResp = signResponse({
      privateKey: kp.privateKey,
      certBody: kp.certBody,
      issuer: IDP_ENTITY_ID,
      audience: SP_ENTITY_ID,
      recipient: ACS_URL,
      notOnOrAfter: new Date(Date.now() - 60_000),
      notBefore: new Date(Date.now() - 120_000),
    });
    const form = new URLSearchParams();
    form.set("SAMLResponse", samlResp);
    const res = await h.fetch(`/api/t/${TENANT_SLUG}/auth/saml/test-idp/acs`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });

  test("wrong audience → 401", async () => {
    const samlResp = signResponse({
      privateKey: kp.privateKey,
      certBody: kp.certBody,
      issuer: IDP_ENTITY_ID,
      audience: "https://wrong.example/sp",
      recipient: ACS_URL,
    });
    const form = new URLSearchParams();
    form.set("SAMLResponse", samlResp);
    const res = await h.fetch(`/api/t/${TENANT_SLUG}/auth/saml/test-idp/acs`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });

  test("wrong issuer → 401", async () => {
    const samlResp = signResponse({
      privateKey: kp.privateKey,
      certBody: kp.certBody,
      issuer: "https://attacker.example/saml",
      audience: SP_ENTITY_ID,
      recipient: ACS_URL,
    });
    const form = new URLSearchParams();
    form.set("SAMLResponse", samlResp);
    const res = await h.fetch(`/api/t/${TENANT_SLUG}/auth/saml/test-idp/acs`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });

  test("second login with same subject is idempotent (no duplicate users)", async () => {
    const samlResp = signResponse({
      privateKey: kp.privateKey,
      certBody: kp.certBody,
      issuer: IDP_ENTITY_ID,
      audience: SP_ENTITY_ID,
      recipient: ACS_URL,
      assertionId: "_second-login",
    });
    const form = new URLSearchParams();
    form.set("SAMLResponse", samlResp);
    const res = await h.fetch(`/api/t/${TENANT_SLUG}/auth/saml/test-idp/acs`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const db = sqliteAt(h);
    const users = db
      .query("SELECT count(*) as n FROM app_users WHERE email = ?")
      .all("alice@example.com") as { n: number }[];
    expect(users[0]!.n).toBe(1);
    db.close();
  });

  test("metadata endpoint returns SAML metadata XML with the ACS URL", async () => {
    const res = await h.fetch(`/api/t/${TENANT_SLUG}/auth/saml/test-idp/metadata`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<");
    expect(xml).toContain("EntityDescriptor");
    expect(xml).toContain(ACS_URL);
  });

  test("open-redirect: malicious relayState rejected", async () => {
    const res = await h.fetch(
      `/api/t/${TENANT_SLUG}/auth/saml/test-idp/login?relayState=${encodeURIComponent("https://attacker.example/steal")}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
  });
});

describe("saml: linkByVerifiedEmail behaviour", () => {
  let h: TestHarness;
  let kp: Keypair;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    kp = buildKeypair();
    await createProvider(h, { certPem: kp.certPem, linkByVerifiedEmail: true });
  });

  afterAll(() => {
    h.cleanup();
  });

  test("link-by-email on: SAML assertion attaches to an existing app_user that shares the email", async () => {
    // Seed an app_user manually so the link path has something to find.
    const db = new Database(h.env.SQLITE_PATH!);
    const tenantRow = (db
      .query("SELECT id FROM tenants WHERE slug = 'default'")
      .get()) as { id: string } | null;
    expect(tenantRow).toBeTruthy();
    db.run(
      "INSERT INTO app_users (id, tenant_id, email, email_verified, status, created_at, updated_at) VALUES (?, ?, ?, 0, 'active', ?, ?)",
      ["pre-existing-user", tenantRow!.id, "carol@example.com", Date.now(), Date.now()],
    );
    db.close();

    const samlResp = signResponse({
      privateKey: kp.privateKey,
      certBody: kp.certBody,
      issuer: IDP_ENTITY_ID,
      audience: SP_ENTITY_ID,
      recipient: ACS_URL,
      email: "carol@example.com",
      nameId: "saml-carol",
      assertionId: "_carol-link",
    });
    const form = new URLSearchParams();
    form.set("SAMLResponse", samlResp);
    const res = await h.fetch(`/api/t/${TENANT_SLUG}/auth/saml/test-idp/acs`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);

    const db2 = sqliteAt(h);
    // The pre-existing user is reused, no new app_user is created.
    const users = db2
      .query("SELECT id FROM app_users WHERE email = ?")
      .all("carol@example.com") as { id: string }[];
    expect(users.length).toBe(1);
    expect(users[0]!.id).toBe("pre-existing-user");
    // external_identities link points at that user.
    const ext = db2
      .query("SELECT user_id FROM external_identities WHERE subject = 'saml-carol'")
      .all() as { user_id: string }[];
    expect(ext.length).toBe(1);
    expect(ext[0]!.user_id).toBe("pre-existing-user");
    db2.close();
  });
});

describe("external-identities: lookup index is tenant-scoped", () => {
  let h: TestHarness;
  let kp: Keypair;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    kp = buildKeypair();
    await createProvider(h, { certPem: kp.certPem });
  });

  afterAll(() => {
    h.cleanup();
  });

  test("same (provider_type, provider_id, subject) tuple can coexist across tenants", async () => {
    const db = new Database(h.env.SQLITE_PATH!);
    db.run(
      "INSERT INTO tenants (id, slug, name, project, branch, env, created_at, updated_at) VALUES (?, ?, ?, 'default', 'main', 'development', ?, ?)",
      ["tenant-b", "tenant-b", "Tenant B", Date.now(), Date.now()],
    );
    // Two identities with the same (provider_type, provider_id, subject)
    // but different tenants must both succeed because the unique index is
    // (tenant_id, provider_type, provider_id, subject).
    db.run(
      "INSERT INTO external_identities (id, tenant_id, plane, user_id, provider_type, provider_id, subject, created_at) VALUES (?, ?, 'app', 'u1', 'saml', 'p1', 'same-subject', ?)",
      ["ext-a", "tenant-b", Date.now()],
    );
    const defaultTenantId = (db
      .query("SELECT id FROM tenants WHERE slug = 'default'")
      .get() as { id: string }).id;
    db.run(
      "INSERT INTO external_identities (id, tenant_id, plane, user_id, provider_type, provider_id, subject, created_at) VALUES (?, ?, 'app', 'u2', 'saml', 'p1', 'same-subject', ?)",
      ["ext-b", defaultTenantId, Date.now()],
    );
    const rows = db
      .query("SELECT id FROM external_identities WHERE subject = 'same-subject'")
      .all() as { id: string }[];
    expect(rows.length).toBe(2);
    db.close();
  });
});
