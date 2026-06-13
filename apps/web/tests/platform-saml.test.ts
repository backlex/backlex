/**
 * Control-plane (admin) SAML SSO — end-to-end against the in-process app.
 *
 * Mirrors tests/saml.test.ts but for the PLATFORM plane: the ACS provisions a
 * `users` row (not `app_users`), writes `platform_external_identities`, and —
 * the load-bearing assertion — mints a better-auth COOKIE session that a
 * follow-up `GET /api/auth/get-session` accepts. That round-trip is the proof
 * `mintPlatformSession`'s hand-built signed cookie matches what better-auth's
 * own `getSession` verifies.
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import forge from "node-forge";
import { SignedXml } from "xml-crypto";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

type Keypair = { privateKey: string; certPem: string; certBody: string };

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
  cert.setSubject([{ name: "commonName", value: "backlex-platform-saml-test" }]);
  cert.setIssuer([{ name: "commonName", value: "backlex-platform-saml-test" }]);
  cert.sign(pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  const certPem = pki.certificateToPem(cert);
  const certBody = certPem.replace(
    /-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s+/g,
    "",
  );
  return { privateKey, certPem, certBody };
};

interface FixtureArgs {
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
  assertionId?: string;
  tamperAfterSign?: boolean;
}

const signResponse = (args: FixtureArgs): string => {
  const now = new Date();
  const responseId = `_${Math.random().toString(36).slice(2)}`;
  const assertionId = args.assertionId ?? `_${Math.random().toString(36).slice(2)}`;
  const notBefore = (args.notBefore ?? new Date(now.getTime() - 60_000)).toISOString();
  const notOnOrAfter = (args.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000)).toISOString();
  const issueInstant = now.toISOString();
  const email = args.email ?? "alice@example.com";
  const nameId = args.nameId ?? email;
  const groupsXml = (args.groups ?? [])
    .map((g) => `<saml2:AttributeValue>${g}</saml2:AttributeValue>`)
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<saml2p:Response xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" Destination="${args.recipient}" ID="${responseId}" IssueInstant="${issueInstant}" Version="2.0">
  <saml2:Issuer>${args.issuer}</saml2:Issuer>
  <saml2p:Status><saml2p:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></saml2p:Status>
  <saml2:Assertion ID="${assertionId}" IssueInstant="${issueInstant}" Version="2.0">
    <saml2:Issuer>${args.issuer}</saml2:Issuer>
    <saml2:Subject>
      <saml2:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml2:NameID>
      <saml2:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml2:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${args.recipient}"/>
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
      <saml2:Attribute Name="lastName"><saml2:AttributeValue>Admin</saml2:AttributeValue></saml2:Attribute>
      ${groupsXml ? `<saml2:Attribute Name="groups">${groupsXml}</saml2:Attribute>` : ""}
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
  if (args.tamperAfterSign) signed = signed.replace(/alice@example\.com/g, "mallory@example.com");
  return Buffer.from(signed).toString("base64");
};

const IDP_ENTITY_ID = "https://idp.example/platform-saml";
const APP_URL = "http://localhost:5173";
const ACS_URL = `${APP_URL}/api/auth/saml/admin-idp/acs`;
const SP_ENTITY_ID = `${APP_URL}/api/auth/saml/admin-idp/metadata`;

const createProvider = async (
  h: TestHarness,
  certPem: string,
  opts: {
    domainMatch?: string[];
    groupsToRoles?: Record<string, { tenantId: string; roleId: string }>;
  } = {},
) => {
  const res = await h.fetch("/api/admin/platform-saml/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Admin IdP",
      slug: "admin-idp",
      entityId: IDP_ENTITY_ID,
      ssoUrl: `${IDP_ENTITY_ID}/sso`,
      idpCertPem: certPem,
      spEntityId: SP_ENTITY_ID,
      attributeMap: { email: "email", firstName: "firstName", lastName: "lastName", groups: "groups" },
      ...(opts.domainMatch ? { domainMatch: opts.domainMatch } : {}),
      ...(opts.groupsToRoles ? { groupsToRoles: opts.groupsToRoles } : {}),
    }),
  });
  if (!res.ok) throw new Error(`create provider failed: ${res.status} ${await res.text()}`);
  return res.json();
};

const acsPost = (h: TestHarness, samlResponse: string) => {
  const form = new URLSearchParams();
  form.set("SAMLResponse", samlResponse);
  return h.fetch("/api/auth/saml/admin-idp/acs", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
};

const sqliteAt = (h: TestHarness): Database => new Database(h.env.SQLITE_PATH!, { readonly: true });

describe("platform saml: ACS provisions users + mints an accepted cookie session", () => {
  let h: TestHarness;
  let kp: Keypair;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    kp = buildKeypair();
    await createProvider(h, kp.certPem);
  });

  afterAll(() => h.cleanup());

  test("happy path: 302, sets session cookie, provisions users + platform_external_identities", async () => {
    const res = await acsPost(
      h,
      signResponse({
        privateKey: kp.privateKey,
        certBody: kp.certBody,
        issuer: IDP_ENTITY_ID,
        audience: SP_ENTITY_ID,
        recipient: ACS_URL,
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(APP_URL);
    // A session cookie was set.
    const setCookies = res.headers.getSetCookie?.() ?? [];
    expect(setCookies.some((sc) => sc.includes("session_token"))).toBe(true);

    const db = sqliteAt(h);
    const users = db
      .query("SELECT id FROM users WHERE email = ?")
      .all("alice@example.com") as { id: string }[];
    expect(users.length).toBe(1);
    const idents = db
      .query("SELECT user_id, subject FROM platform_external_identities WHERE provider_type = 'saml'")
      .all() as { user_id: string; subject: string }[];
    expect(idents.length).toBe(1);
    expect(idents[0]!.subject).toBe("alice@example.com");
    expect(idents[0]!.user_id).toBe(users[0]!.id);
    db.close();
  });

  test("load-bearing: the minted cookie is accepted by better-auth get-session", async () => {
    // The harness cookie jar now holds the SSO user's session_token (it
    // replaced the seeded admin's on the ACS response). get-session must
    // resolve it to the provisioned operator.
    const res = await h.fetch("/api/auth/get-session");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: { email?: string } } | null;
    expect(body?.user?.email).toBe("alice@example.com");
  });

  test("replay: same assertion twice → 401", async () => {
    const saml = signResponse({
      privateKey: kp.privateKey,
      certBody: kp.certBody,
      issuer: IDP_ENTITY_ID,
      audience: SP_ENTITY_ID,
      recipient: ACS_URL,
      assertionId: "_platform-replay",
    });
    expect((await acsPost(h, saml)).status).toBe(302);
    expect((await acsPost(h, saml)).status).toBe(401);
  });

  test("tampered signature → 401", async () => {
    const res = await acsPost(
      h,
      signResponse({
        privateKey: kp.privateKey,
        certBody: kp.certBody,
        issuer: IDP_ENTITY_ID,
        audience: SP_ENTITY_ID,
        recipient: ACS_URL,
        tamperAfterSign: true,
      }),
    );
    expect(res.status).toBe(401);
  });

  test("expired NotOnOrAfter → 401", async () => {
    const res = await acsPost(
      h,
      signResponse({
        privateKey: kp.privateKey,
        certBody: kp.certBody,
        issuer: IDP_ENTITY_ID,
        audience: SP_ENTITY_ID,
        recipient: ACS_URL,
        notOnOrAfter: new Date(Date.now() - 60_000),
        notBefore: new Date(Date.now() - 120_000),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("idempotent: second login with same subject creates no duplicate user", async () => {
    const res = await acsPost(
      h,
      signResponse({
        privateKey: kp.privateKey,
        certBody: kp.certBody,
        issuer: IDP_ENTITY_ID,
        audience: SP_ENTITY_ID,
        recipient: ACS_URL,
        assertionId: "_platform-second",
      }),
    );
    expect(res.status).toBe(302);
    const db = sqliteAt(h);
    const n = db
      .query("SELECT count(*) as n FROM users WHERE email = ?")
      .all("alice@example.com") as { n: number }[];
    expect(n[0]!.n).toBe(1);
    db.close();
  });

  test("metadata endpoint returns SAML metadata XML with the platform ACS URL", async () => {
    const res = await h.fetch("/api/auth/saml/admin-idp/metadata");
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("EntityDescriptor");
    expect(xml).toContain(ACS_URL);
  });

  test("open-redirect: malicious relayState rejected", async () => {
    const res = await h.fetch(
      `/api/auth/saml/admin-idp/login?relayState=${encodeURIComponent("https://attacker.example/steal")}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(403);
  });
});

describe("platform saml: suspended operator can't re-enter via SSO", () => {
  let h: TestHarness;
  let kp: Keypair;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    kp = buildKeypair();
    await createProvider(h, kp.certPem);
  });
  afterAll(() => h.cleanup());

  test("provision, then suspend → next SSO login is 403", async () => {
    expect(
      (await acsPost(
        h,
        signResponse({
          privateKey: kp.privateKey,
          certBody: kp.certBody,
          issuer: IDP_ENTITY_ID,
          audience: SP_ENTITY_ID,
          recipient: ACS_URL,
          assertionId: "_susp-1",
        }),
      )).status,
    ).toBe(302);

    const wdb = new Database(h.env.SQLITE_PATH!);
    wdb.run("UPDATE users SET status = 'suspended' WHERE email = ?", ["alice@example.com"]);
    wdb.close();

    const res = await acsPost(
      h,
      signResponse({
        privateKey: kp.privateKey,
        certBody: kp.certBody,
        issuer: IDP_ENTITY_ID,
        audience: SP_ENTITY_ID,
        recipient: ACS_URL,
        assertionId: "_susp-2",
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("platform saml: JIT domain allow-list", () => {
  let h: TestHarness;
  let kp: Keypair;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    kp = buildKeypair();
    await createProvider(h, kp.certPem, { domainMatch: ["allowed.example"] });
  });
  afterAll(() => h.cleanup());

  test("off-allowlist email → 403, no user provisioned", async () => {
    const res = await acsPost(
      h,
      signResponse({
        privateKey: kp.privateKey,
        certBody: kp.certBody,
        issuer: IDP_ENTITY_ID,
        audience: SP_ENTITY_ID,
        recipient: ACS_URL,
        email: "bob@elsewhere.example",
        nameId: "bob",
        assertionId: "_dom-deny",
      }),
    );
    expect(res.status).toBe(403);
    const db = sqliteAt(h);
    const n = (db.query("SELECT count(*) as n FROM users WHERE email = ?").get("bob@elsewhere.example") as { n: number }).n;
    expect(n).toBe(0);
    db.close();
  });

  test("in-allowlist email → 302, provisioned", async () => {
    const res = await acsPost(
      h,
      signResponse({
        privateKey: kp.privateKey,
        certBody: kp.certBody,
        issuer: IDP_ENTITY_ID,
        audience: SP_ENTITY_ID,
        recipient: ACS_URL,
        email: "carol@allowed.example",
        nameId: "carol",
        assertionId: "_dom-allow",
      }),
    );
    expect(res.status).toBe(302);
    const db = sqliteAt(h);
    const n = (db.query("SELECT count(*) as n FROM users WHERE email = ?").get("carol@allowed.example") as { n: number }).n;
    expect(n).toBe(1);
    db.close();
  });
});

describe("platform saml: tenant-aware group→role mapping", () => {
  let h: TestHarness;
  let kp: Keypair;
  let tenant2 = "";
  const roleId = "role-ws2-ops";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    kp = buildKeypair();
    // A second workspace + a role inside it.
    const db = new Database(h.env.SQLITE_PATH!);
    tenant2 = "tenant-ws2";
    const now = Date.now();
    db.run(
      "INSERT INTO tenants (id, slug, name, project, branch, env, created_at, updated_at) VALUES (?, 'ws2', 'WS2', 'default', 'main', 'development', ?, ?)",
      [tenant2, now, now],
    );
    db.run(
      "INSERT INTO roles (id, tenant_id, name, description, admin, created_at, updated_at) VALUES (?, ?, 'ops', 'ops', 0, ?, ?)",
      [roleId, tenant2, now, now],
    );
    db.close();
    await createProvider(h, kp.certPem, {
      groupsToRoles: { "cn=ops": { tenantId: tenant2, roleId } },
    });
  });
  afterAll(() => h.cleanup());

  test("group maps to a role in a non-default workspace + auto-members the user there", async () => {
    const res = await acsPost(
      h,
      signResponse({
        privateKey: kp.privateKey,
        certBody: kp.certBody,
        issuer: IDP_ENTITY_ID,
        audience: SP_ENTITY_ID,
        recipient: ACS_URL,
        email: "dave@example.com",
        nameId: "dave",
        groups: ["cn=ops"],
        assertionId: "_grp-1",
      }),
    );
    expect(res.status).toBe(302);
    const db = sqliteAt(h);
    const uid = (db.query("SELECT id FROM users WHERE email = ?").get("dave@example.com") as { id: string }).id;
    // role from the ws2 group mapping is assigned via user_roles
    const ridRows = db.query("SELECT role_id FROM user_roles WHERE user_id = ?").all(uid) as { role_id: string }[];
    expect(ridRows.some((r) => r.role_id === roleId)).toBe(true);
    // and the operator was auto-membered into ws2
    const mem = db
      .query("SELECT id FROM tenant_members WHERE tenant_id = ? AND email = ?")
      .all(tenant2, "dave@example.com") as { id: string }[];
    expect(mem.length).toBe(1);
    db.close();
  });
});

describe("platform saml: feature gate", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness({ PLATFORM_SSO_ENABLED: "false" });
    await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  test("admin CRUD 404s when PLATFORM_SSO_ENABLED=false", async () => {
    const res = await h.fetch("/api/admin/platform-saml/providers");
    expect(res.status).toBe(404);
  });

  test("login route 404s when disabled", async () => {
    const res = await h.fetch("/api/auth/saml/admin-idp/login", { redirect: "manual" });
    expect(res.status).toBe(404);
  });
});
