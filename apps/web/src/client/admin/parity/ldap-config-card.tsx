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
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@workeros/ui/components/input";
import { ScrollArea } from "@workeros/ui/components/scroll-area";
import { Textarea } from "@workeros/ui/components/textarea";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { I } from "../icons";
import { Badge, Button, Switch } from "../ui";
import { Select } from "../select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workeros/ui/components/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
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
  const { t } = useLingui();
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
      pushToast?.(t`LDAP config saved.`);
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
      pushToast?.(enabled ? t`LDAP enabled.` : t`LDAP disabled.`);
    } catch (e) {
      patch({ enabled: !enabled });
      pushToast?.((e as Error).message);
    }
  };

  if (!loaded) {
    // First-load placeholder — mirrors the card's header strip + body fields.
    return (
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="h-4 w-44" />
          <div className="flex-1" />
          <Skeleton className="h-8 w-32" />
        </div>
        <div className="flex flex-col gap-3 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3.5">
        <I.Shield size={13} className="shrink-0" />
        <span className="text-[13px] font-medium"><Trans>LDAP / Active Directory</Trans></span>
        <Badge variant={cfg.enabled ? "default" : "secondary"}>
          {cfg.enabled ? <Trans>enabled</Trans> : <Trans>disabled</Trans>}
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" icon={I.Activity} onClick={() => setTestOpen(true)}>
            <Trans>Test connection</Trans>
          </Button>
          <Switch checked={cfg.enabled} onChange={(v) => void toggleEnabled(v)} />
        </div>
      </div>

      <div className="grid gap-3.5 px-4 py-3.5">
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>LDAP URL</Trans></label>
          <Input
            value={cfg.url}
            onChange={(e) => patch({ url: e.target.value })}
            placeholder="ldaps://dc1.corp.example:636"
          />
          <span className="text-[11.5px] text-muted-foreground"><Trans>Use <span className="font-mono">ldaps://</span> in production; <span className="font-mono">ldap://</span> only on a trusted network.</Trans></span>
        </div>

        <div className="grid grid-cols-2 gap-3.5 max-[640px]:grid-cols-1">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Bind DN</Trans></label>
            <Input
              value={cfg.bindDn}
              onChange={(e) => patch({ bindDn: e.target.value })}
              placeholder="cn=workeros,ou=service,dc=corp,dc=example"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
              <Trans>Bind password</Trans>
              {cfg.secretsSet.bindPassword && !clearPw && (
                <Badge variant="secondary" className="ml-1.5"><Trans>set</Trans></Badge>
              )}
            </label>
            <div className="flex gap-1.5">
              <Input
                type="password"
                value={pwInput}
                disabled={clearPw}
                onChange={(e) => setPwInput(e.target.value)}
                placeholder={cfg.secretsSet.bindPassword ? t`leave blank to keep current` : t`service-account password`}
                className="flex-1"
              />
              {cfg.secretsSet.bindPassword && (
                <Button size="sm" variant="ghost" onClick={() => setClearPw((v) => !v)}>
                  {clearPw ? <Trans>Cancel clear</Trans> : <Trans>Clear</Trans>}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Base DN (search root)</Trans></label>
          <Input
            value={cfg.baseDn}
            onChange={(e) => patch({ baseDn: e.target.value })}
            placeholder="ou=users,dc=corp,dc=example"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>User filter</Trans></label>
          <Textarea
            rows={2}
            value={cfg.userFilter}
            onChange={(e) => patch({ userFilter: e.target.value })}
            className="font-mono h-auto text-xs"
          />
          <span className="text-[11.5px] text-muted-foreground">
            <Trans><span className="font-mono">{"{{username}}"}</span> is replaced with the submitted username (RFC-4515 escaped).
            Common: AD = <span className="font-mono">(sAMAccountName={"{{username}}"})</span>, OpenLDAP = <span className="font-mono">(uid={"{{username}}"})</span>.</Trans>
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Attribute map</Trans></label>
          <div className="grid grid-cols-2 gap-2.5 max-[640px]:grid-cols-1">
            {(["email", "firstName", "lastName", "groups"] as const).map((k) => (
              <div key={k} className="flex items-center gap-2">
                <span className="w-20 font-mono text-[11px] text-muted-foreground">{k}</span>
                <Input
                  value={cfg.attributeMap[k] ?? ""}
                  onChange={(e) =>
                    patch({
                      attributeMap: { ...cfg.attributeMap, [k]: e.target.value },
                    })
                  }
                  className="flex-1"
                />
              </div>
            ))}
          </div>
          <span className="text-[11.5px] text-muted-foreground">
            <Trans>AD defaults: <span className="font-mono">mail · givenName · sn · memberOf</span>. OpenLDAP commonly uses <span className="font-mono">mail · givenName · sn · memberOf</span> (or the <span className="font-mono">groupOfNames</span> overlay).</Trans>
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3.5 max-[640px]:grid-cols-1">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Default role on first sign-in</Trans></label>
            <Select
              value={cfg.defaultRoleId ?? ""}
              onChange={(v) => patch({ defaultRoleId: v ? v : null })}
              options={[
                { value: "", label: t`— none —` },
                ...availableRoles.map((r) => ({ value: r.id, label: r.name })),
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Rate limit (per email / minute)</Trans></label>
            <Input
              type="number"
              min={1}
              max={600}
              value={cfg.rateLimitPerMinute}
              onChange={(e) => patch({ rateLimitPerMinute: Number(e.target.value) || 10 })}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Allowed email domains (optional)</Trans></label>
          <Input
            value={domainText}
            onChange={(e) => setDomainText(e.target.value)}
            placeholder={t`corp.example.com, contractor.example.com`}
          />
          <span className="text-[11.5px] text-muted-foreground"><Trans>Comma- or space-separated. When set, email-looking usernames from other domains are rejected before the LDAP roundtrip.</Trans></span>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>TLS</Trans></label>
          <label className="flex items-center gap-2 text-xs">
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
            <Trans>Reject unauthorized certs (recommended)</Trans>
          </label>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
            <Trans>Custom CA PEM (optional)</Trans>
            {cfg.secretsSet.caPem && !clearCa && (
              <Badge variant="secondary" className="ml-1.5"><Trans>set</Trans></Badge>
            )}
          </label>
          <div className="flex items-start gap-1.5">
            <Textarea
              rows={4}
              disabled={clearCa}
              value={caInput}
              onChange={(e) => setCaInput(e.target.value)}
              placeholder={cfg.secretsSet.caPem ? t`leave blank to keep current` : "-----BEGIN CERTIFICATE-----..."}
              className="font-mono h-auto flex-1 text-[11.5px]"
            />
            {cfg.secretsSet.caPem && (
              <Button size="sm" variant="ghost" onClick={() => setClearCa((v) => !v)}>
                {clearCa ? <Trans>Cancel clear</Trans> : <Trans>Clear</Trans>}
              </Button>
            )}
          </div>
          <span className="text-[11.5px] text-muted-foreground"><Trans>Only needed for self-signed LDAPS; the system trust store handles publicly-signed certs.</Trans></span>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={saving} onClick={() => void load()}>
            <Trans>Revert</Trans>
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
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
  const { t } = useLingui();
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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="border-b border-border px-5 py-3.5 pr-12 text-left">
          <DialogTitle className="text-[13px] font-medium"><Trans>Test LDAP connection</Trans></DialogTitle>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
        <div className="grid gap-3 px-5 py-[18px]">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Username</Trans></label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t`alice`}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Password</Trans></label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="primary" disabled={busy || !username || !password} onClick={() => void run()}>
              {busy ? <Trans>Authenticating…</Trans> : <Trans>Run test</Trans>}
            </Button>
          </div>
          {result && result.ok && (
            <div className="rounded-2xl border border-border bg-card p-3 text-card-foreground">
              <div className="mb-1.5 text-xs font-medium">
                <Trans>Authentication succeeded</Trans>
                <Badge variant="default" className="ml-1.5">ok</Badge>
              </div>
              <div className="mb-2 font-mono text-[11.5px] [word-break:break-all] text-muted-foreground">
                {result.dn}
              </div>
              <Table className="text-xs [&_td]:px-3.5 [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground">
                <TableHeader><TableRow><TableHead><Trans>Field</Trans></TableHead><TableHead><Trans>Map →</Trans></TableHead><TableHead><Trans>Value</Trans></TableHead></TableRow></TableHeader>
                <TableBody>
                  <TableRow><TableCell>email</TableCell><TableCell className="font-mono text-muted-foreground">{attributeMap.email}</TableCell><TableCell>{result.attributes.email ?? <span className="text-muted-foreground">—</span>}</TableCell></TableRow>
                  <TableRow><TableCell>firstName</TableCell><TableCell className="font-mono text-muted-foreground">{attributeMap.firstName}</TableCell><TableCell>{result.attributes.firstName ?? <span className="text-muted-foreground">—</span>}</TableCell></TableRow>
                  <TableRow><TableCell>lastName</TableCell><TableCell className="font-mono text-muted-foreground">{attributeMap.lastName}</TableCell><TableCell>{result.attributes.lastName ?? <span className="text-muted-foreground">—</span>}</TableCell></TableRow>
                  <TableRow><TableCell>groups</TableCell><TableCell className="font-mono text-muted-foreground">{attributeMap.groups}</TableCell><TableCell className="font-mono text-[11px]">{result.attributes.groups.length === 0 ? <span className="text-muted-foreground">—</span> : result.attributes.groups.join("\n")}</TableCell></TableRow>
                </TableBody>
              </Table>
            </div>
          )}
          {result && !result.ok && (
            <div className="rounded-2xl border border-border bg-card p-3 text-card-foreground">
              <div className="mb-1.5 text-xs font-medium text-destructive">
                <Trans>Authentication failed</Trans>
              </div>
              <div className="text-xs text-muted-foreground">{result.reason}</div>
            </div>
          )}
        </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
