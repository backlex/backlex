// @ts-nocheck
/**
 * Platform SSO settings — instance-global SAML + LDAP for dashboard operators.
 * Distinct from the workspace-scoped "Authentication" page (which configures
 * end-user auth). Talks to /api/admin/platform-saml + /api/admin/platform-ldap-config.
 */
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { I } from "../icons";
import { Badge, Button, PageHeader, Switch } from "../ui";
import { ConfirmDialog } from "../sheet";
import {
  platformLdapAdminApi,
  platformSamlAdminApi,
  type ApiPlatformLdapConfig,
  type ApiPlatformSamlProvider,
} from "../api";
import { apiOrigin, copyText } from "./_shared";
import { useAuthSurface } from "@/lib/auth";

export function PlatformSsoSettingsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const { surface } = useAuthSurface();
  const [providers, setProviders] = useState<ApiPlatformSamlProvider[]>([]);
  const [ldap, setLdap] = useState<ApiPlatformLdapConfig | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ id: string } | null>(null);

  const loadSaml = async () => {
    try {
      setProviders((await platformSamlAdminApi.list()).data ?? []);
    } catch {
      setProviders([]);
    }
  };
  const loadLdap = async () => {
    try {
      setLdap((await platformLdapAdminApi.load()).data ?? null);
    } catch {
      setLdap(null);
    }
  };
  useEffect(() => {
    void loadSaml();
    void loadLdap();
  }, []);

  const toggleSaml = async (row: ApiPlatformSamlProvider, enabled: boolean) => {
    setProviders((a) => a.map((r) => (r.id === row.id ? { ...r, enabled } : r)));
    try {
      await platformSamlAdminApi.update(row.id, { enabled });
    } catch (e) {
      pushToast((e as Error).message);
      setProviders((a) => a.map((r) => (r.id === row.id ? { ...r, enabled: !enabled } : r)));
    }
  };
  const doRemove = async (id: string) => {
    try {
      await platformSamlAdminApi.remove(id);
      setProviders((a) => a.filter((r) => r.id !== id));
      pushToast(t`Provider deleted.`);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  if (surface && surface.platformSso === false) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={t`Platform SSO`}
          description={t`Enterprise SSO for operators signing into this dashboard.`}
        />
        <Card className="px-4 py-6 text-[13px] text-muted-foreground">
          <Trans>
            Platform SSO is not enabled on this instance. It's available on plans
            with enterprise SSO, or on self-hosted deployments.
          </Trans>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t`Platform SSO`}
        description={t`Enterprise SSO for operators signing into this dashboard. Separate from workspace end-user auth.`}
      />

      {/* SAML */}
      <Card className="gap-0 py-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.Shield size={13} />
          <span className="text-[13px] font-medium"><Trans>SAML 2.0 SSO</Trans></span>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {providers.length} {providers.length === 1 ? t`provider` : t`providers`}
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="outline" icon={I.Plus} onClick={() => setAddOpen(true)}>
            <Trans>Add SAML</Trans>
          </Button>
        </div>
        {providers.length === 0 && (
          <div className="border-b border-border px-4 py-3.5 text-[12.5px] text-muted-foreground">
            <Trans>No SAML providers configured. Operators will sign in with email/password until you add one.</Trans>
          </div>
        )}
        {providers.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3.5 py-3 text-[13px] last:border-b-0"
          >
            <I.Shield size={13} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{p.name}</div>
              <div className="font-mono text-[11px] text-muted-foreground">{p.entityId}</div>
              {!p.idpCertSet && (
                <div className="text-[11px] text-destructive">
                  <Trans>No signing cert stored — login will fail.</Trans>
                </div>
              )}
            </div>
            <Badge variant="default">SAML</Badge>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove({ id: p.id })}>
              <Trans>Delete</Trans>
            </Button>
            <Switch checked={p.enabled} onChange={(v) => void toggleSaml(p, v)} />
          </div>
        ))}
      </Card>

      {/* LDAP */}
      <PlatformLdapCard config={ldap} onSaved={loadLdap} pushToast={pushToast} />

      {addOpen && (
        <AddSamlDialog
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            void loadSaml();
          }}
          pushToast={pushToast}
        />
      )}
      {confirmRemove && (
        <ConfirmDialog
          open
          destructive
          title={t`Delete SAML provider?`}
          description={t`Operators using this IdP will no longer be able to sign in.`}
          actionLabel={t`Delete`}
          onConfirm={() => {
            void doRemove(confirmRemove.id);
            setConfirmRemove(null);
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </div>
  );
}

function AddSamlDialog({
  onClose,
  onSaved,
  pushToast,
}: {
  onClose: () => void;
  onSaved: () => void;
  pushToast: (m: string) => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [entityId, setEntityId] = useState("");
  const [ssoUrl, setSsoUrl] = useState("");
  const [idpCertPem, setIdpCertPem] = useState("");
  const [domainText, setDomainText] = useState("");
  const [metadataXml, setMetadataXml] = useState("");
  const [busy, setBusy] = useState(false);

  const base = apiOrigin();
  const effSlug = slug.trim() || "<slug>";
  const acsUrl = `${base}/api/auth/saml/${effSlug}/acs`;
  const metadataUrl = `${base}/api/auth/saml/${effSlug}/metadata`;

  const importMeta = async () => {
    if (!metadataXml.trim()) return;
    setBusy(true);
    try {
      const r = await platformSamlAdminApi.importMetadata({ metadataXml: metadataXml.trim() });
      setEntityId(r.data.entityId);
      setSsoUrl(r.data.ssoUrl);
      setIdpCertPem(r.data.idpCertPem);
      pushToast(t`Metadata parsed — review and save.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!name.trim() || !entityId.trim() || !ssoUrl.trim() || !idpCertPem.trim()) {
      pushToast(t`Name, Entity ID, SSO URL and IdP certificate are required.`);
      return;
    }
    setBusy(true);
    try {
      const domains = domainText
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
      await platformSamlAdminApi.create({
        name: name.trim(),
        slug: slug.trim() || undefined,
        entityId: entityId.trim(),
        ssoUrl: ssoUrl.trim(),
        idpCertPem: idpCertPem.trim(),
        spEntityId: metadataUrl,
        attributeMap: { email: "email", firstName: "firstName", lastName: "lastName", groups: "groups" },
        domainMatch: domains.length > 0 ? domains : null,
      });
      onSaved();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-w-lg flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle><Trans>Add SAML provider</Trans></DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-[13px]">
          <Field label={t`Name`}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Okta" />
          </Field>
          <Field label={t`Slug (URL handle)`}>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="okta" />
          </Field>
          <div className="rounded-md border border-border p-2 text-[11.5px] text-muted-foreground">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono">ACS: {acsUrl}</span>
              <Button size="xs" variant="ghost" onClick={() => copyText(acsUrl)}><Trans>Copy</Trans></Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono">Metadata: {metadataUrl}</span>
              <Button size="xs" variant="ghost" onClick={() => copyText(metadataUrl)}><Trans>Copy</Trans></Button>
            </div>
          </div>
          <Field label={t`Paste IdP metadata XML (optional — prefills the fields below)`}>
            <Textarea
              value={metadataXml}
              onChange={(e) => setMetadataXml(e.target.value)}
              rows={3}
              placeholder="<EntityDescriptor …>"
            />
            <Button size="xs" variant="outline" className="mt-1" onClick={() => void importMeta()} disabled={busy}>
              <Trans>Parse metadata</Trans>
            </Button>
          </Field>
          <Field label={t`IdP Entity ID`}>
            <Input value={entityId} onChange={(e) => setEntityId(e.target.value)} />
          </Field>
          <Field label={t`IdP SSO URL`}>
            <Input value={ssoUrl} onChange={(e) => setSsoUrl(e.target.value)} />
          </Field>
          <Field label={t`IdP signing certificate (PEM)`}>
            <Textarea value={idpCertPem} onChange={(e) => setIdpCertPem(e.target.value)} rows={4} placeholder="-----BEGIN CERTIFICATE-----" />
          </Field>
          <Field label={t`Allowed email domains (optional, comma-separated)`}>
            <Input
              value={domainText}
              onChange={(e) => setDomainText(e.target.value)}
              placeholder="acme.com, acme.co.uk"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              <Trans>Leave empty to provision any operator your IdP authenticates. Set domains to restrict who gets a dashboard account.</Trans>
            </p>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button onClick={() => void save()} disabled={busy}><Trans>Create</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlatformLdapCard({
  config,
  onSaved,
  pushToast,
}: {
  config: ApiPlatformLdapConfig | null;
  onSaved: () => void;
  pushToast: (m: string) => void;
}) {
  const { t } = useLingui();
  const [cfg, setCfg] = useState<ApiPlatformLdapConfig | null>(config);
  const [bindPassword, setBindPassword] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setCfg(config), [config]);
  const c = cfg ?? {
    id: "singleton",
    enabled: false,
    url: "",
    bindDn: "",
    baseDn: "",
    userFilter: "(&(objectClass=person)(uid={{username}}))",
    groupFilter: null,
    attributeMap: { email: "mail", firstName: "givenName", lastName: "sn", groups: "memberOf" },
    defaultRoleId: null,
    groupsToRoles: null,
    tlsOptions: null,
    secretsSet: { bindPassword: false, caPem: false },
    domainMatch: null,
    rateLimitPerMinute: 10,
    updatedAt: null,
  };

  const set = (patch: Partial<ApiPlatformLdapConfig>) => setCfg({ ...c, ...patch });

  const save = async (override: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        enabled: c.enabled,
        url: c.url,
        bindDn: c.bindDn,
        baseDn: c.baseDn,
        userFilter: c.userFilter,
        attributeMap: c.attributeMap,
        rateLimitPerMinute: c.rateLimitPerMinute,
        ...override,
      };
      if (bindPassword.trim()) body.secrets = { bindPassword: bindPassword.trim() };
      await platformLdapAdminApi.save(body);
      setBindPassword("");
      pushToast(t`LDAP config saved.`);
      onSaved();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <I.Shield size={13} />
        <span className="text-[13px] font-medium"><Trans>LDAP / Active Directory</Trans></span>
        <div className="flex-1" />
        <Switch checked={c.enabled} onChange={(v) => set({ enabled: v })} />
      </div>
      <div className="space-y-3 px-4 py-3.5 text-[13px]">
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11.5px] text-muted-foreground">
          <Trans>LDAP runs only on self-hosted (Bun/Node) deployments — it is unavailable on Cloudflare Workers, which block raw TCP. Use SAML there.</Trans>
        </div>
        <Field label={t`Server URL`}>
          <Input value={c.url} onChange={(e) => set({ url: e.target.value })} placeholder="ldaps://dc1.corp.example:636" />
        </Field>
        <Field label={t`Bind DN`}>
          <Input value={c.bindDn} onChange={(e) => set({ bindDn: e.target.value })} placeholder="cn=svc,ou=service,dc=corp,dc=example" />
        </Field>
        <Field label={t`Bind password`}>
          <Input
            type="password"
            value={bindPassword}
            onChange={(e) => setBindPassword(e.target.value)}
            placeholder={c.secretsSet.bindPassword ? "•••••••• (stored)" : ""}
          />
        </Field>
        <Field label={t`Base DN`}>
          <Input value={c.baseDn} onChange={(e) => set({ baseDn: e.target.value })} placeholder="ou=users,dc=corp,dc=example" />
        </Field>
        <Field label={t`User filter`}>
          <Input value={c.userFilter} onChange={(e) => set({ userFilter: e.target.value })} />
        </Field>
        <Field label={t`Email attribute`}>
          <Input
            value={c.attributeMap.email}
            onChange={(e) => set({ attributeMap: { ...c.attributeMap, email: e.target.value } })}
          />
        </Field>
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={busy}><Trans>Save LDAP config</Trans></Button>
        </div>
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[11.5px] font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
