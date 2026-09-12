/**
 * samlify-backed SAML 2.0 service-provider adapter. See
 * packages/core/src/adapters/saml.ts for the contract.
 *
 * The adapter is stateless: every call builds a fresh samlify SP + IdP pair
 * from the {@link SamlProviderConfig}. We don't cache the entities because
 * config changes (cert rotation, attribute-map edits) must be visible on the
 * very next request — and the entity construction itself is cheap.
 *
 * Runtime: samlify imports `xml-crypto` which uses `node:crypto`. That
 * resolves under Cloudflare Workers' `nodejs_compat` flag, which the
 * deployment already enables (apps/web/wrangler.toml). On Bun / Vercel /
 * Netlify the native Node crypto works directly.
 *
 * Schema validation: samlify expects a schema validator to be globally
 * installed (production deployments would use `@authenio/samlify-libxml`
 * or `@authenio/samlify-validate-with-xmllint`). We install a no-op
 * validator here because:
 *   - signature verification is *always* enforced separately by samlify;
 *   - the alternative (importing a libxml2-based validator) hard-pins the
 *     runtime to Node + a native binary, killing Workers compatibility.
 * The trade-off is that we trust samlify's own XPath-based extractor +
 * signature check to reject malformed XML (it does), at the cost of not
 * rejecting valid-XML-but-wrong-schema responses up-front.
 */
import * as samlifyNs from "samlify";
import type {
  SamlAdapter,
  SamlAssertion,
  SamlAuthnRequest,
  SamlLogoutRequest,
  SamlProviderConfig,
} from "@backlex/core/adapters";

// `samlify` is CJS; normalise the import shape regardless of how the
// downstream bundler resolves `* as`.
type Samlify = typeof samlifyNs;
const samlify: Samlify =
  (samlifyNs as { default?: Samlify } & Samlify).default ?? samlifyNs;

// Install a no-op schema validator once per isolate. samlify throws if you
// invoke `parseLoginResponse` without one configured. Signature verification
// is enforced independently of schema validation.
let schemaValidatorInstalled = false;
const ensureSchemaValidator = (): void => {
  if (schemaValidatorInstalled) return;
  samlify.setSchemaValidator({
    validate: async () => "skipped",
  });
  schemaValidatorInstalled = true;
};

const SAML_SIG_ALG: Record<NonNullable<SamlProviderConfig["signatureAlgorithm"]>, string> = {
  sha1: "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
  sha256: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  sha512: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
};

const NAME_ID_FORMATS: Record<string, string> = {
  emailAddress: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  persistent: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  transient: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
  unspecified: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
};

const resolveNameIdFormat = (fmt: string | undefined): string => {
  if (!fmt) return NAME_ID_FORMATS.emailAddress!;
  return NAME_ID_FORMATS[fmt] ?? fmt;
};

const buildIdp = (cfg: SamlProviderConfig) =>
  samlify.IdentityProvider({
    entityID: cfg.entityId,
    singleSignOnService: [
      { Binding: samlify.Constants.namespace.binding.redirect, Location: cfg.ssoUrl },
    ],
    ...(cfg.sloUrl
      ? {
          singleLogoutService: [
            { Binding: samlify.Constants.namespace.binding.redirect, Location: cfg.sloUrl },
          ],
        }
      : {}),
    signingCert: cfg.idpCertPem,
    isAssertionEncrypted: false,
  });

const buildSp = (cfg: SamlProviderConfig) =>
  samlify.ServiceProvider({
    entityID: cfg.spEntityId,
    assertionConsumerService: [
      {
        Binding: samlify.Constants.namespace.binding.post,
        Location: cfg.acsUrl,
        isDefault: true,
      },
    ],
    ...(cfg.sloAcsUrl
      ? {
          singleLogoutService: [
            {
              Binding: samlify.Constants.namespace.binding.redirect,
              Location: cfg.sloAcsUrl,
            },
          ],
        }
      : {}),
    wantAssertionsSigned: cfg.wantSignedAssertions,
    signingCert: cfg.idpCertPem,
    nameIDFormat: [resolveNameIdFormat(cfg.nameIdFormat)],
    requestSignatureAlgorithm:
      SAML_SIG_ALG[cfg.signatureAlgorithm ?? "sha256"],
  });

/** Pull the AuthnRequest ID out of the samlify-generated redirect URL. The
 *  redirect binding wraps a base64 + zlib-deflated request, but samlify also
 *  exposes the ID via `entityEndpoint`-style helpers; if those aren't
 *  available we fall back to extracting from the deflated XML. */
const extractRequestId = (ctx: { id?: string; entityEndpoint?: string; context?: string }): string => {
  if (typeof ctx.id === "string" && ctx.id.length > 0) return ctx.id;
  // The samlify redirect binding returns `{ id, context }` where `context`
  // is the full URL — we don't try to deflate the request to extract the id
  // a second time. Fail loud rather than mint a fake id that won't match the
  // ACS handler's `inResponseTo` lookup.
  throw new Error("samlify did not return an AuthnRequest id");
};

const toStringArray = (v: string | string[] | undefined): string[] => {
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (typeof v === "string" && v.length > 0) return [v];
  return [];
};

/**
 * The fields a replay guard is allowed to trust, read from the assertion node
 * the SIGNATURE covered rather than from the document that carried it.
 *
 * samlify already re-roots most of its extractor at the verified assertion
 * (`Extractor.loginResponseFields` passes it as `shortcut`), but its catalog
 * has no Assertion-ID entry at all: the only `ID` it reads sits under
 * `localPath: ['Response']` with no shortcut, i.e. it comes from the whole
 * document. Under the default `wantSignedAssertions: true` that envelope is
 * unsigned, so anything keyed on it can be changed by whoever holds the
 * captured response — which is exactly how the replay guard was bypassed.
 *
 * `SamlLib.verifySignature` hands back `sig.getSignedReferences()[0]`, narrowed
 * to the `<Assertion>` — samlify's own words for it are "the cryptographically
 * authenticated assertion node". Extracting from that string is the whole
 * difference between a signed and an unsigned identifier. The price is one
 * extra signature verification per SSO login; a login is not a hot path, and
 * the alternative is reading `@ID` off the raw document, which is the
 * signature-wrapping hole this closes.
 *
 * Two shapes are queried because `verifySignature` returns the `<Assertion>`
 * fragment in the ordinary case and the enclosing `<Response>` when the
 * assertion arrived encrypted. Whichever matched is the one that was signed.
 */
const SIGNED_SCOPE_FIELDS: Array<{
  key: string;
  localPath: string[];
  attributes: string[];
}> = [
  { key: "idDirect", localPath: ["Assertion"], attributes: ["ID"] },
  { key: "idNested", localPath: ["Response", "Assertion"], attributes: ["ID"] },
  {
    key: "recipientDirect",
    localPath: [
      "Assertion",
      "Subject",
      "SubjectConfirmation",
      "SubjectConfirmationData",
    ],
    attributes: ["Recipient"],
  },
  {
    key: "recipientNested",
    localPath: [
      "Response",
      "Assertion",
      "Subject",
      "SubjectConfirmation",
      "SubjectConfirmationData",
    ],
    attributes: ["Recipient"],
  },
];

const firstString = (...vals: unknown[]): string | undefined => {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0) return v[0];
  }
  return undefined;
};

/**
 * Re-derive the signed assertion's own identity.
 *
 * Throws rather than returning a placeholder when the id cannot be
 * established. The implementation this replaces defaulted to
 * `` `${Date.now()}_${Math.random()}` ``, and a per-request unique replay key
 * is a replay guard that matches nothing while reporting success on every
 * call — the failure mode that is invisible until someone replays an
 * assertion.
 */
const readSignedScope = (
  idp: ReturnType<typeof buildIdp>,
  samlContent: string,
): { assertionId: string; recipient?: string } => {
  const [verified, signedNode] = samlify.SamlLib.verifySignature(samlContent, {
    metadata: idp.entityMeta,
    signatureAlgorithm: idp.entitySetting.requestSignatureAlgorithm,
  });
  if (!verified || !signedNode) {
    // Unreachable in practice: `parseLoginResponse` has already rejected an
    // unverifiable response. Kept because "the guard could not read the thing
    // it guards" must fail closed, not silently degrade.
    throw new Error("SAML signature did not yield an authenticated assertion");
  }
  const ex = samlify.Extractor.extract(signedNode, SIGNED_SCOPE_FIELDS);
  const assertionId = firstString(ex.idDirect, ex.idNested);
  if (!assertionId) {
    throw new Error("SAML assertion has no ID inside the signed scope");
  }
  return {
    assertionId,
    recipient: firstString(ex.recipientDirect, ex.recipientNested),
  };
};

const parseConditionsNotOnOrAfter = (
  cond: Record<string, string | string[]> | undefined,
): Date => {
  const raw = cond?.notOnOrAfter ?? cond?.NotOnOrAfter;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    // The library already rejects past times during verifyTime — but if a
    // malformed value sneaks through we fail closed.
    throw new Error("SAML assertion missing NotOnOrAfter");
  }
  return parsed;
};

export const samlifySamlAdapter = (): SamlAdapter => {
  ensureSchemaValidator();
  return {
    async buildAuthnRequest(cfg, options): Promise<SamlAuthnRequest> {
      const idp = buildIdp(cfg);
      const sp = buildSp(cfg);
      const ctx = sp.createLoginRequest(idp, "redirect", {
        relayState: options.relayState,
      }) as { id?: string; context: string; entityEndpoint?: string };
      const url = (ctx as { context?: string }).context ?? "";
      if (!url) throw new Error("samlify did not return a redirect URL");
      return {
        url,
        requestId: extractRequestId(ctx),
      };
    },

    async verifyAssertion(cfg, samlResponseB64): Promise<SamlAssertion> {
      const idp = buildIdp(cfg);
      const sp = buildSp(cfg);
      const flow = await sp.parseLoginResponse(idp, "post", {
        body: { SAMLResponse: samlResponseB64 },
      });
      const ex = flow.extract as {
        nameID?: string;
        issuer?: string | string[];
        conditions?: Record<string, string | string[]>;
        sessionIndex?: Record<string, string | string[]>;
        attributes?: Record<string, string | string[]>;
        response?: Record<string, string | string[]>;
        audience?: string | string[];
        authnContextClassRef?: string | string[];
        nameIDPolicy?: Record<string, string | string[]>;
      };
      const nameId = ex.nameID;
      if (!nameId) throw new Error("SAML assertion missing NameID");
      const issuer = Array.isArray(ex.issuer) ? ex.issuer[0] : ex.issuer;
      if (!issuer) throw new Error("SAML assertion missing Issuer");
      const audienceRaw = ex.audience ?? ex.conditions?.audience;
      const audience = Array.isArray(audienceRaw) ? audienceRaw[0] : audienceRaw;
      if (!audience) throw new Error("SAML assertion missing Audience");
      // Cross-check the audience against the SP entity id; samlify's
      // conditions check covers this, but we re-assert it to keep our
      // failure modes explicit.
      if (audience !== cfg.spEntityId) {
        throw new Error(`SAML audience mismatch: ${audience} ≠ ${cfg.spEntityId}`);
      }
      // Issuer must match the configured IdP entity id (samlify checks too).
      if (issuer !== cfg.entityId) {
        throw new Error(`SAML issuer mismatch: ${issuer} ≠ ${cfg.entityId}`);
      }
      // Materialise attributes as Record<string, string[]>.
      const attrsIn = ex.attributes ?? {};
      const attributes: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(attrsIn)) attributes[k] = toStringArray(v);

      const responseInfo = ex.response ?? {};
      const inResponseTo = Array.isArray(responseInfo.inResponseTo)
        ? responseInfo.inResponseTo[0]
        : responseInfo.inResponseTo;
      // `response` is extracted from the whole document with no `shortcut`, so
      // every field on it is OUTSIDE the signature when only the assertion is
      // signed. Both are reported, neither is trusted — see `SamlAssertion`.
      const responseId = Array.isArray(responseInfo.id)
        ? responseInfo.id[0]
        : responseInfo.id;
      const destination = Array.isArray(responseInfo.destination)
        ? responseInfo.destination[0]
        : responseInfo.destination;
      const sessionIndexRaw = ex.sessionIndex?.sessionIndex ?? ex.sessionIndex?.SessionIndex;
      const sessionIndex = Array.isArray(sessionIndexRaw)
        ? sessionIndexRaw[0]
        : sessionIndexRaw;
      const authnRaw = ex.authnContextClassRef;
      const authnContext = Array.isArray(authnRaw) ? authnRaw[0] : authnRaw;
      const signed = readSignedScope(idp, flow.samlContent);
      return {
        assertionId: signed.assertionId,
        responseId: responseId ?? undefined,
        recipient: signed.recipient,
        destination: destination ?? undefined,
        issuer,
        nameId,
        nameIdFormat: cfg.nameIdFormat,
        audience,
        inResponseTo: inResponseTo ?? undefined,
        notOnOrAfter: parseConditionsNotOnOrAfter(ex.conditions),
        sessionIndex,
        authnContext,
        attributes,
      };
    },

    async buildLogoutRequest(cfg, args): Promise<SamlLogoutRequest | null> {
      if (!cfg.sloUrl) return null;
      const idp = buildIdp(cfg);
      const sp = buildSp(cfg);
      const ctx = sp.createLogoutRequest(idp, "redirect", {
        logoutNameID: args.nameId,
        sessionIndex: args.sessionIndex,
      }) as { context?: string };
      const url = ctx.context;
      if (!url) return null;
      return { url };
    },

    metadataXml(cfg): string {
      const sp = buildSp(cfg);
      return sp.getMetadata();
    },
  };
};
