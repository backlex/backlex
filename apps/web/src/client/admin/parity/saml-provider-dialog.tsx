// @ts-nocheck
/**
 * SAML provider create/edit dialog. Three top tabs:
 *
 *   1. From template — preset attribute maps for popular IdPs.
 *   2. Import metadata — paste XML or fetch by URL; pre-fills entity/SSO/cert.
 *   3. Manual entry — type every field by hand.
 *
 * After form submission the parent's `onSave` handler is called with a
 * {@link SamlProviderCreate}-shaped patch.
 *
 * Read-only metadata block at the bottom surfaces the three IdP-side URLs
 * (SP entity id, ACS, metadata) the admin will paste into the IdP console.
 *
 * Lives in /parity/ so it can read the shared `card`/`field` CSS classes
 * the rest of the admin page uses. shadcn-only rule: every interactive
 * element here is a `Button` / `Switch` / `Select` / `Badge` from
 * `@/admin/ui` (the local re-export of @workeros/ui).
 */
import { useEffect, useMemo, useState } from "react";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { I } from "../icons";
import { Badge, Button, Switch } from "../ui";
import { Select } from "../select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import {
  samlAdminApi,
  type ApiSamlProvider,
  type SamlProviderCreate,
} from "../api";
import { apiOrigin, copyText } from "./_shared";

interface AvailableRole {
  id: string;
  name: string;
}

interface SamlProviderDialogProps {
  /** When non-null, the dialog is in edit mode for this provider. */
  existing: ApiSamlProvider | null;
  /** Tenant slug for synthesising the ACS / metadata URLs on the right. */
  workspaceSlug: string;
  availableRoles: AvailableRole[];
  onClose: () => void;
  onSaved: (saved: ApiSamlProvider) => void;
  pushToast?: (msg: string) => void;
}

type Mode = "template" | "import" | "manual" | "test";

const IDP_TEMPLATES: {
  id: string;
  label: string;
  attributes: Record<string, string>;
  notes?: string;
}[] = [
  {
    id: "okta",
    label: "Okta",
    attributes: {
      email: "email",
      firstName: "firstName",
      lastName: "lastName",
      groups: "groups",
    },
  },
  {
    id: "azure",
    label: "Azure AD / Entra ID",
    attributes: {
      email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
      firstName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
      lastName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
      groups: "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
    },
  },
  {
    id: "google",
    label: "Google Workspace",
    attributes: {
      email: "email",
      firstName: "first_name",
      lastName: "last_name",
      groups: "groups",
    },
  },
  {
    id: "adfs",
    label: "ADFS",
    attributes: {
      email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
      firstName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
      lastName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
      groups: "http://schemas.xmlsoap.org/claims/Group",
    },
  },
  {
    id: "jumpcloud",
    label: "JumpCloud",
    attributes: {
      email: "email",
      firstName: "firstname",
      lastName: "lastname",
      groups: "groups",
    },
  },
  {
    id: "auth0",
    label: "Auth0",
    attributes: {
      email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
      firstName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
      lastName: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
      groups: "groups",
    },
  },
];

const NAMEID_FORMATS = [
  "emailAddress",
  "persistent",
  "transient",
  "unspecified",
];
const SIG_ALGS = ["sha1", "sha256", "sha512"];

export function SamlProviderDialog({
  existing,
  workspaceSlug,
  availableRoles,
  onClose,
  onSaved,
  pushToast,
}: SamlProviderDialogProps) {
  const isEdit = !!existing;
  const [mode, setMode] = useState<Mode>(isEdit ? "manual" : "template");

  // Editable fields.
  const [name, setName] = useState(existing?.name ?? "");
  const [slug, setSlug] = useState(existing?.slug ?? "");
  const [idpTemplate, setIdpTemplate] = useState<string | null>(existing?.idpTemplate ?? null);
  const [entityId, setEntityId] = useState(existing?.entityId ?? "");
  const [ssoUrl, setSsoUrl] = useState(existing?.ssoUrl ?? "");
  const [sloUrl, setSloUrl] = useState(existing?.sloUrl ?? "");
  const [idpCertPem, setIdpCertPem] = useState("");
  const [spEntityId, setSpEntityId] = useState(existing?.spEntityId ?? "");
  const [attrMap, setAttrMap] = useState<Record<string, string>>(
    existing?.attributeMap ?? { email: "email", firstName: "firstName", lastName: "lastName", groups: "groups" },
  );
  const [defaultRoleId, setDefaultRoleId] = useState<string | null>(existing?.defaultRoleId ?? null);
  const [sigAlg, setSigAlg] = useState<string>(existing?.signatureAlgorithm ?? "sha256");
  const [wantSigned, setWantSigned] = useState<boolean>(existing?.wantSignedAssertions ?? true);
  const [linkByEmail, setLinkByEmail] = useState<boolean>(existing?.linkByVerifiedEmail ?? false);
  const [nameIdFormat, setNameIdFormat] = useState<string>(existing?.nameIdFormat ?? "emailAddress");
  const [enabled, setEnabled] = useState<boolean>(existing?.enabled ?? true);

  // Import sub-state.
  const [importXml, setImportXml] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);

  // Test assertion sub-state.
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<unknown>(null);
  const [testBusy, setTestBusy] = useState(false);

  // Synthesised slug from name when not edited.
  const effectiveSlug = (slug || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // Pre-compute the read-only URL block.
  const base = apiOrigin().replace(/\/+$/, "");
  const acsUrl = `${base}/api/t/${workspaceSlug}/auth/saml/${effectiveSlug || "<slug>"}/acs`;
  const metadataUrl = `${base}/api/t/${workspaceSlug}/auth/saml/${effectiveSlug || "<slug>"}/metadata`;
  const sloAcsUrl = `${base}/api/t/${workspaceSlug}/auth/saml/${effectiveSlug || "<slug>"}/slo`;

  useEffect(() => {
    // When the dialog opens for create with no spEntityId yet, default to
    // our own metadata URL — most IdPs are happiest with that.
    if (!isEdit && !spEntityId && effectiveSlug) setSpEntityId(metadataUrl);
  }, [effectiveSlug, isEdit, metadataUrl, spEntityId]);

  const applyTemplate = (id: string) => {
    const t = IDP_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setIdpTemplate(id);
    setAttrMap(t.attributes);
    setMode("manual");
  };

  const runImport = async () => {
    if (!importXml.trim() && !importUrl.trim()) return;
    setImporting(true);
    try {
      const res = await samlAdminApi.importMetadata({
        metadataXml: importXml.trim() || undefined,
        metadataUrl: importUrl.trim() || undefined,
      });
      const d = res.data;
      setEntityId(d.entityId);
      setSsoUrl(d.ssoUrl);
      setSloUrl(d.sloUrl ?? "");
      setIdpCertPem(d.idpCertPem);
      setSpEntityId(d.spEntityIdSuggested);
      setMode("manual");
      pushToast?.("Metadata imported.");
    } catch (e) {
      pushToast?.((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const runTest = async () => {
    if (!existing) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      const res = await samlAdminApi.testAssertion(existing.id, testInput.trim());
      setTestResult(res.data);
    } catch (e) {
      pushToast?.((e as Error).message);
    } finally {
      setTestBusy(false);
    }
  };

  const submit = async () => {
    const body: SamlProviderCreate = {
      name: name.trim(),
      slug: slug.trim() || undefined,
      idpTemplate,
      entityId: entityId.trim(),
      ssoUrl: ssoUrl.trim(),
      sloUrl: sloUrl.trim() || null,
      idpCertPem: idpCertPem.trim() || (existing ? "" : ""),
      spEntityId: spEntityId.trim(),
      attributeMap: attrMap,
      defaultRoleId: defaultRoleId || null,
      signatureAlgorithm: sigAlg as "sha1" | "sha256" | "sha512",
      wantSignedAssertions: wantSigned,
      linkByVerifiedEmail: linkByEmail,
      nameIdFormat,
      enabled,
    };
    try {
      if (existing) {
        // PATCH: omit idpCertPem if empty so we don't clobber the stored value.
        const patch: Partial<SamlProviderCreate> = { ...body };
        if (!body.idpCertPem) delete patch.idpCertPem;
        const res = await samlAdminApi.update(existing.id, patch);
        onSaved(res.data);
        pushToast?.("Provider saved.");
      } else {
        if (!body.idpCertPem) {
          pushToast?.("IdP signing certificate (PEM) is required.");
          return;
        }
        const res = await samlAdminApi.create(body);
        onSaved(res.data);
        pushToast?.("Provider created.");
      }
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const validToSubmit =
    name.trim().length >= 1 &&
    entityId.trim().length >= 1 &&
    ssoUrl.trim().length >= 1 &&
    spEntityId.trim().length >= 1 &&
    (existing || idpCertPem.trim().length >= 20);

  const TabButton = ({ id, children }: { id: Mode; children: React.ReactNode }) => (
    <Button
      size="sm"
      variant={mode === id ? "outline" : "ghost"}
      onClick={() => setMode(id)}
    >
      {children}
    </Button>
  );

  const Row = ({ label, value }: { label: string; value: string }) => (
    <div className="schema-row" style={{ gridTemplateColumns: "1fr auto" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500 }}>{label}</div>
        <div
          className="font-mono muted"
          style={{
            fontSize: 11.5,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {value}
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void copyText(value, () => pushToast?.("Copied."))}
      >
        Copy
      </Button>
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="dialog-lg flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]">
        <DialogHeader className="dialog-head pr-12 text-left">
          <DialogTitle style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>
            {isEdit ? `Configure ${existing!.name}` : "Add SAML provider"}
          </DialogTitle>
          <DialogDescription className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
            SAML 2.0 SSO — workspace end-users.
          </DialogDescription>
        </DialogHeader>

        <div className="dialog-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 6 }}>
            {!isEdit && <TabButton id="template">From template</TabButton>}
            {!isEdit && <TabButton id="import">Import metadata</TabButton>}
            <TabButton id="manual">Manual entry</TabButton>
            {isEdit && <TabButton id="test">Test assertion</TabButton>}
          </div>

          {mode === "template" && (
            <div className="field">
              <label className="field-label">Pick a template</label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
                {IDP_TEMPLATES.map((t) => (
                  <Button
                    key={t.id}
                    variant="outline"
                    size="sm"
                    onClick={() => applyTemplate(t.id)}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>
              <span className="field-hint">
                Sets the attribute map to that IdP's defaults — you can still tweak later.
              </span>
            </div>
          )}

          {mode === "import" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="field">
                <label className="field-label">Metadata XML</label>
                <Textarea
                  rows={6}
                  value={importXml}
                  onChange={(e) => setImportXml(e.target.value)}
                  placeholder='<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example/saml">…'
                  style={{ height: "auto", fontFamily: "Geist Mono, monospace", fontSize: 12 }}
                />
              </div>
              <div className="muted" style={{ fontSize: 11.5 }}>or</div>
              <div className="field">
                <label className="field-label">Metadata URL</label>
                <Input
                  className="font-mono"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="https://idp.example/saml/metadata"
                />
              </div>
              <div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={importing || (!importXml.trim() && !importUrl.trim())}
                  onClick={runImport}
                >
                  {importing ? "Fetching…" : "Fetch & parse"}
                </Button>
              </div>
            </div>
          )}

          {mode === "manual" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="field">
                <label className="field-label">Display name</label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Okta"
                  autoFocus
                />
              </div>
              <div className="field">
                <label className="field-label">Slug</label>
                <Input
                  className="font-mono"
                  value={slug || effectiveSlug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder="okta"
                />
                <span className="field-hint">Used in the ACS / metadata URLs below.</span>
              </div>
              <div className="field">
                <label className="field-label">IdP entity ID (Issuer)</label>
                <Input
                  className="font-mono"
                  value={entityId}
                  onChange={(e) => setEntityId(e.target.value)}
                  placeholder="https://idp.example.com/saml"
                />
              </div>
              <div className="field">
                <label className="field-label">IdP SSO URL</label>
                <Input
                  className="font-mono"
                  value={ssoUrl}
                  onChange={(e) => setSsoUrl(e.target.value)}
                  placeholder="https://idp.example.com/saml/sso"
                />
              </div>
              <div className="field">
                <label className="field-label">IdP SLO URL <span className="muted">(optional)</span></label>
                <Input
                  className="font-mono"
                  value={sloUrl}
                  onChange={(e) => setSloUrl(e.target.value)}
                  placeholder="https://idp.example.com/saml/slo"
                />
              </div>
              <div className="field">
                <label className="field-label">
                  IdP signing cert (PEM) {existing && existing.idpCertSet && <Badge variant="secondary">already set</Badge>}
                </label>
                <Textarea
                  rows={6}
                  value={idpCertPem}
                  onChange={(e) => setIdpCertPem(e.target.value)}
                  placeholder={"-----BEGIN CERTIFICATE-----\nMIID…\n-----END CERTIFICATE-----"}
                  style={{ height: "auto", fontFamily: "Geist Mono, monospace", fontSize: 12 }}
                />
                {existing && existing.idpCertSet && (
                  <span className="field-hint">Leave blank to keep the stored cert.</span>
                )}
              </div>
              <div className="field">
                <label className="field-label">SP entity ID</label>
                <Input
                  className="font-mono"
                  value={spEntityId}
                  onChange={(e) => setSpEntityId(e.target.value)}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
                <div className="field">
                  <label className="field-label">Email attribute</label>
                  <Input
                    className="font-mono"
                    value={attrMap.email ?? ""}
                    onChange={(e) => setAttrMap({ ...attrMap, email: e.target.value })}
                    placeholder="email"
                  />
                </div>
                <div className="field">
                  <label className="field-label">First name</label>
                  <Input
                    className="font-mono"
                    value={attrMap.firstName ?? ""}
                    onChange={(e) => setAttrMap({ ...attrMap, firstName: e.target.value })}
                    placeholder="firstName"
                  />
                </div>
                <div className="field">
                  <label className="field-label">Last name</label>
                  <Input
                    className="font-mono"
                    value={attrMap.lastName ?? ""}
                    onChange={(e) => setAttrMap({ ...attrMap, lastName: e.target.value })}
                    placeholder="lastName"
                  />
                </div>
                <div className="field">
                  <label className="field-label">Groups</label>
                  <Input
                    className="font-mono"
                    value={attrMap.groups ?? ""}
                    onChange={(e) => setAttrMap({ ...attrMap, groups: e.target.value })}
                    placeholder="groups"
                  />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
                <div className="field">
                  <label className="field-label">Default role</label>
                  <Select
                    value={defaultRoleId ?? ""}
                    onChange={(v) => setDefaultRoleId(v || null)}
                    options={[
                      { value: "", label: "— none —" },
                      ...availableRoles.map((r) => ({ value: r.id, label: r.name })),
                    ]}
                  />
                </div>
                <div className="field">
                  <label className="field-label">NameID format</label>
                  <Select value={nameIdFormat} onChange={(v) => setNameIdFormat(v)} options={NAMEID_FORMATS} />
                </div>
                <div className="field">
                  <label className="field-label">Signature algorithm</label>
                  <Select value={sigAlg} onChange={(v) => setSigAlg(v)} options={SIG_ALGS} />
                </div>
              </div>

              <div className="field-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <div>
                  <div className="field-label">Want signed assertions</div>
                  <div className="field-hint">Reject responses whose assertion isn't signed by the IdP.</div>
                </div>
                <Switch checked={wantSigned} onChange={setWantSigned} />
              </div>
              <div className="field-row">
                <div>
                  <div className="field-label">Link by verified email</div>
                  <div className="field-hint">
                    Risk: a hostile IdP can take over any local account that shares an email. Off by default.
                  </div>
                </div>
                <Switch checked={linkByEmail} onChange={setLinkByEmail} />
              </div>
              <div className="field-row">
                <div>
                  <div className="field-label">Enabled</div>
                  <div className="field-hint">Off keeps the provider configured but hidden from sign-in.</div>
                </div>
                <Switch checked={enabled} onChange={setEnabled} />
              </div>

              <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <span style={{ fontSize: 12, fontWeight: 500 }}>SP URLs <span className="muted">(paste into the IdP console)</span></span>
                <Row label="ACS URL" value={acsUrl} />
                <Row label="Metadata URL" value={metadataUrl} />
                <Row label="SLO URL" value={sloAcsUrl} />
              </div>
            </div>
          )}

          {mode === "test" && existing && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="field">
                <label className="field-label">Paste a base64 SAMLResponse</label>
                <Textarea
                  rows={6}
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  placeholder="PHNhbWwycDpSZXNwb25zZSB4bWxuczpzYW1sMnA9…"
                  style={{ height: "auto", fontFamily: "Geist Mono, monospace", fontSize: 12 }}
                />
              </div>
              <div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={testBusy || testInput.trim().length === 0}
                  onClick={runTest}
                >
                  {testBusy ? "Verifying…" : "Verify"}
                </Button>
              </div>
              {testResult ? (
                <pre
                  className="font-mono"
                  style={{
                    margin: 0,
                    padding: 12,
                    background: "var(--muted)",
                    borderRadius: 8,
                    fontSize: 11.5,
                    maxHeight: 240,
                    overflow: "auto",
                  }}
                >
                  {JSON.stringify(testResult, null, 2)}
                </pre>
              ) : null}
            </div>
          )}
        </div>

        <div className="dialog-foot">
          <span className="muted" style={{ fontSize: 12 }}>
            {validToSubmit ? (isEdit ? "Ready to save." : "Ready to create.") : "Fill the required fields."}
          </span>
          <div className="spacer" />
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={isEdit ? I.Save : I.Plus}
            disabled={!validToSubmit}
            onClick={submit}
          >
            {isEdit ? "Save" : "Add provider"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
