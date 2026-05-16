// @ts-nocheck
/**
 * LDAP / Active Directory config card. One-row-per-workspace config, edited
 * inline (no multi-provider list — directories are usually consolidated and
 * customers wire a single LDAPS endpoint). Lives in /parity/ so it can read
 * the shared `card`/`field` CSS classes the rest of the admin page uses.
 *
 * shadcn-only rule: every interactive element comes from `@/admin/ui`
 * (the local re-export of `@workeros/ui`).
 *
 * Secrets — `bindPassword` and `caPem` — are never returned by the server.
 * The card shows a "set" badge when `secretsSet.bindPassword === true`, and
 * the input is treated as additive: leaving it blank keeps the stored
 * ciphertext intact. A "Clear" action removes the key entirely.
 */
import { useEffect, useState } from "react";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { I } from "../icons";
import { Badge, Button, Switch } from "../ui";
import { Select } from "../select";
import {
  ldapAdminApi,
  type ApiLdapConfig,
  type LdapConfigPatch,
} from "../api";

interface Role {
  id: string;
  name: string;
}

interface Props {
  availableRoles: Role[];
  pushToast?: (msg: string) => void;
}

const DEFAULT_USER_FILTER = "(&(objectClass=person)(uid={{username}}))";

const emptyConfig = (): ApiLdapConfig => ({
  tenantId: "",
  enabled: false,
  url: "",
  bindDn: "",
  baseDn: "",
  userFilter: DEFAULT_USER_FILTER,
  groupFilter: null,
  attributeMap: { email: "mail", firstName: "givenName", lastName: "sn", groups: "memberOf" },
  defaultRoleId: null,
  groupsToRoles: null,
  tlsOptions: null,
  secretsSet: { bindPassword: false, caPem: false },
  domainMatch: null,
  rateLimitPerMinute: 10,
  updatedAt: null,
});

export function LdapConfigCard({ availableRoles, pushToast }: Props) {
  const [cfg, setCfg] = useState<ApiLdapConfig>(emptyConfig());
  const [pwInput, setPwInput] = useState("");
  const [clearPw, setClearPw] = useState(false);
  const [caInput, setCaInput] = useState("");
  const [clearCa, setClearCa] = useState(false);
  const [domainText, setDomainText] = useState("");
  const [testOpen, setTestOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    try {
      const r = await ldapAdminApi.load();
      const data = r.data ?? emptyConfig();
      setCfg(data);
      setDomainText((data.domainMatch ?? []).join(", "));
    } catch {
      setCfg(emptyConfig());
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const patch = (p: Partial<ApiLdapConfig>) => setCfg((prev) => ({ ...prev, ...p }));

  const save = async (overrides: LdapConfigPatch = {}) => {
    setSaving(true);
    try {
      const secrets: LdapConfigPatch["secrets"] = {};
      if (clearPw) secrets.bindPassword = null;
      else if (pwInput.trim()) secrets.bindPassword = pwInput.trim();
      if (clearCa) secrets.caPem = null;
      else if (caInput.trim()) secrets.caPem = caInput.trim();
      const domains = domainText
        .split(/[,\s]+/)
        .map((d) => d.trim())
        .filter(Boolean);
      const body: LdapConfigPatch = {
        enabled: cfg.enabled,
        url: cfg.url,
        bindDn: cfg.bindDn,
        baseDn: cfg.baseDn,
        userFilter: cfg.userFilter,
        groupFilter: cfg.groupFilter ?? "",
        attributeMap: cfg.attributeMap,
        defaultRoleId: cfg.defaultRoleId,
        tlsOptions: cfg.tlsOptions,
        domainMatch: domains.length > 0 ? domains : null,
        rateLimitPerMinute: cfg.rateLimitPerMinute,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
        ...overrides,
      };
      await ldapAdminApi.save(body);
      pushToast?.("LDAP config saved.");
      setPwInput("");
      setClearPw(false);
      setCaInput("");
      setClearCa(false);
      await load();
    } catch (e) {
      pushToast?.((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (enabled: boolean) => {
    patch({ enabled });
    try {
      await ldapAdminApi.save({ enabled });
      pushToast?.(enabled ? "LDAP enabled." : "LDAP disabled.");
    } catch (e) {
      patch({ enabled: !enabled });
      pushToast?.((e as Error).message);
    }
  };

  if (!loaded) {
    return (
      <div className="card">
        <div className="card-section muted" style={{ fontSize: 12.5 }}>
          Loading LDAP config…
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <I.Shield size={13} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>LDAP / Active Directory</span>
        <Badge variant={cfg.enabled ? "default" : "secondary"}>
          {cfg.enabled ? "enabled" : "disabled"}
        </Badge>
        <div className="spacer" />
        <Button size="sm" variant="outline" icon={I.Activity} onClick={() => setTestOpen(true)}>
          Test connection
        </Button>
        <Switch checked={cfg.enabled} onChange={(v) => void toggleEnabled(v)} />
      </div>

      <div className="card-section" style={{ display: "grid", gap: 14 }}>
        <div className="field">
          <label className="field-label">LDAP URL</label>
          <Input
            value={cfg.url}
            onChange={(e) => patch({ url: e.target.value })}
            placeholder="ldaps://dc1.corp.example:636"
          />
          <span className="field-hint">Use <span className="font-mono">ldaps://</span> in production; <span className="font-mono">ldap://</span> only on a trusted network.</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div className="field">
            <label className="field-label">Bind DN</label>
            <Input
              value={cfg.bindDn}
              onChange={(e) => patch({ bindDn: e.target.value })}
              placeholder="cn=workeros,ou=service,dc=corp,dc=example"
            />
          </div>
          <div className="field">
            <label className="field-label">
              Bind password
              {cfg.secretsSet.bindPassword && !clearPw && (
                <Badge variant="secondary" style={{ marginLeft: 6 }}>set</Badge>
              )}
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <Input
                type="password"
                value={pwInput}
                disabled={clearPw}
                onChange={(e) => setPwInput(e.target.value)}
                placeholder={cfg.secretsSet.bindPassword ? "leave blank to keep current" : "service-account password"}
                style={{ flex: 1 }}
              />
              {cfg.secretsSet.bindPassword && (
                <Button size="sm" variant="ghost" onClick={() => setClearPw((v) => !v)}>
                  {clearPw ? "Cancel clear" : "Clear"}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="field">
          <label className="field-label">Base DN (search root)</label>
          <Input
            value={cfg.baseDn}
            onChange={(e) => patch({ baseDn: e.target.value })}
            placeholder="ou=users,dc=corp,dc=example"
          />
        </div>

        <div className="field">
          <label className="field-label">User filter</label>
          <Textarea
            rows={2}
            value={cfg.userFilter}
            onChange={(e) => patch({ userFilter: e.target.value })}
            style={{ height: "auto", fontFamily: "Geist Mono, monospace", fontSize: 12 }}
          />
          <span className="field-hint">
            <span className="font-mono">{"{{username}}"}</span> is replaced with the submitted username (RFC-4515 escaped).
            Common: AD = <span className="font-mono">(sAMAccountName={"{{username}}"})</span>, OpenLDAP = <span className="font-mono">(uid={"{{username}}"})</span>.
          </span>
        </div>

        <div className="field">
          <label className="field-label">Attribute map</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {(["email", "firstName", "lastName", "groups"] as const).map((k) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="muted font-mono" style={{ fontSize: 11, width: 80 }}>{k}</span>
                <Input
                  value={cfg.attributeMap[k] ?? ""}
                  onChange={(e) =>
                    patch({
                      attributeMap: { ...cfg.attributeMap, [k]: e.target.value },
                    })
                  }
                  style={{ flex: 1 }}
                />
              </div>
            ))}
          </div>
          <span className="field-hint">
            AD defaults: <span className="font-mono">mail · givenName · sn · memberOf</span>. OpenLDAP commonly uses <span className="font-mono">mail · givenName · sn · memberOf</span> (or the <span className="font-mono">groupOfNames</span> overlay).
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div className="field">
            <label className="field-label">Default role on first sign-in</label>
            <Select
              value={cfg.defaultRoleId ?? ""}
              onChange={(v) => patch({ defaultRoleId: v ? v : null })}
              options={[
                { value: "", label: "— none —" },
                ...availableRoles.map((r) => ({ value: r.id, label: r.name })),
              ]}
            />
          </div>
          <div className="field">
            <label className="field-label">Rate limit (per email / minute)</label>
            <Input
              type="number"
              min={1}
              max={600}
              value={cfg.rateLimitPerMinute}
              onChange={(e) => patch({ rateLimitPerMinute: Number(e.target.value) || 10 })}
            />
          </div>
        </div>

        <div className="field">
          <label className="field-label">Allowed email domains (optional)</label>
          <Input
            value={domainText}
            onChange={(e) => setDomainText(e.target.value)}
            placeholder="corp.example.com, contractor.example.com"
          />
          <span className="field-hint">Comma- or space-separated. When set, email-looking usernames from other domains are rejected before the LDAP roundtrip.</span>
        </div>

        <div className="field">
          <label className="field-label">TLS</label>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <Switch
              checked={cfg.tlsOptions?.rejectUnauthorized !== false}
              onChange={(v) =>
                patch({
                  tlsOptions: {
                    ...(cfg.tlsOptions ?? {}),
                    rejectUnauthorized: v,
                  },
                })
              }
            />
            Reject unauthorized certs (recommended)
          </label>
        </div>

        <div className="field">
          <label className="field-label">
            Custom CA PEM (optional)
            {cfg.secretsSet.caPem && !clearCa && (
              <Badge variant="secondary" style={{ marginLeft: 6 }}>set</Badge>
            )}
          </label>
          <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <Textarea
              rows={4}
              disabled={clearCa}
              value={caInput}
              onChange={(e) => setCaInput(e.target.value)}
              placeholder={cfg.secretsSet.caPem ? "leave blank to keep current" : "-----BEGIN CERTIFICATE-----..."}
              style={{ flex: 1, height: "auto", fontFamily: "Geist Mono, monospace", fontSize: 11.5 }}
            />
            {cfg.secretsSet.caPem && (
              <Button size="sm" variant="ghost" onClick={() => setClearCa((v) => !v)}>
                {clearCa ? "Cancel clear" : "Clear"}
              </Button>
            )}
          </div>
          <span className="field-hint">Only needed for self-signed LDAPS; the system trust store handles publicly-signed certs.</span>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="outline" disabled={saving} onClick={() => void load()}>
            Revert
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      {testOpen && (
        <LdapTestDialog
          attributeMap={cfg.attributeMap}
          onClose={() => setTestOpen(false)}
          pushToast={pushToast}
        />
      )}
    </div>
  );
}

function LdapTestDialog({
  attributeMap,
  onClose,
  pushToast,
}: {
  attributeMap: { email: string; firstName: string; lastName: string; groups: string };
  onClose: () => void;
  pushToast?: (m: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { ok: true; dn: string; attributes: { email: string | null; firstName: string | null; lastName: string | null; groups: string[] } }
    | { ok: false; reason: string }
    | null
  >(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await ldapAdminApi.test(username, password);
      setResult(r);
    } catch (e) {
      pushToast?.((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-overlay" role="dialog" aria-modal>
      <div className="sheet" style={{ maxWidth: 640 }}>
        <div className="sheet-header">
          <div style={{ fontSize: 13, fontWeight: 500 }}>Test LDAP connection</div>
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <div className="sheet-body" style={{ display: "grid", gap: 12 }}>
          <div className="field">
            <label className="field-label">Username</label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="alice"
            />
          </div>
          <div className="field">
            <label className="field-label">Password</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button variant="primary" disabled={busy || !username || !password} onClick={() => void run()}>
              {busy ? "Authenticating…" : "Run test"}
            </Button>
          </div>
          {result && result.ok && (
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>
                Authentication succeeded
                <Badge variant="default" style={{ marginLeft: 6 }}>ok</Badge>
              </div>
              <div className="muted font-mono" style={{ fontSize: 11.5, wordBreak: "break-all", marginBottom: 8 }}>
                {result.dn}
              </div>
              <table className="table" style={{ fontSize: 12 }}>
                <thead><tr><th>Field</th><th>Map →</th><th>Value</th></tr></thead>
                <tbody>
                  <tr><td>email</td><td className="muted font-mono">{attributeMap.email}</td><td>{result.attributes.email ?? <span className="muted">—</span>}</td></tr>
                  <tr><td>firstName</td><td className="muted font-mono">{attributeMap.firstName}</td><td>{result.attributes.firstName ?? <span className="muted">—</span>}</td></tr>
                  <tr><td>lastName</td><td className="muted font-mono">{attributeMap.lastName}</td><td>{result.attributes.lastName ?? <span className="muted">—</span>}</td></tr>
                  <tr><td>groups</td><td className="muted font-mono">{attributeMap.groups}</td><td className="font-mono" style={{ fontSize: 11 }}>{result.attributes.groups.length === 0 ? <span className="muted">—</span> : result.attributes.groups.join("\n")}</td></tr>
                </tbody>
              </table>
            </div>
          )}
          {result && !result.ok && (
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, color: "var(--destructive)" }}>
                Authentication failed
              </div>
              <div className="muted" style={{ fontSize: 12 }}>{result.reason}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
