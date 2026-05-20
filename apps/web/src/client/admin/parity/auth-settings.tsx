// @ts-nocheck
import { useEffect, useRef, useState } from "react";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { I } from "../icons";
import { Badge, Button, PageHeader, Switch } from "../ui";
import { Select } from "../select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import {
  authAdminApi,
  tenantsApi,
  rolesApi,
  samlAdminApi,
  type ApiAuthConfig,
  type ApiSamlProvider,
  type ApiSession,
  type ApiTenant,
} from "../api";
import { ConfirmDialog } from "../sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workeros/ui/components/table";
import { apiOrigin, copyText, fmtRelative } from "./_shared";
import { SamlProviderDialog } from "./saml-provider-dialog";
import { LdapConfigCard } from "./ldap-config-card";
import { AuthSettingsSkeleton } from "../page-skeletons";

type AuthProviderRow = {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  system?: boolean;
  clientId?: string | null;
  /** True if this workspace has a client secret stored (encrypted) for the
   *  provider. The plaintext is never returned. */
  hasSecret?: boolean;
  discoveryUrl?: string | null;
};

const AUTH_PROVIDER_NAMES: Record<string, string> = {
  email: "Email + password",
  magic: "Magic link",
  emailOtp: "Email code (OTP)",
  github: "GitHub",
  google: "Google",
  apple: "Apple",
  microsoft: "Microsoft",
  discord: "Discord",
  passkey: "Passkeys (WebAuthn)",
};
const AUTH_OAUTH_IDS = new Set(["github", "google", "apple", "microsoft", "discord"]);
const SESSION_LIFETIMES = ["1h", "24h", "7d", "30d", "90d"];
const POLICY_ROWS: { key: string; label: string; desc: string; fallback: boolean }[] = [
  { key: "requireEmailVerification", label: "Require email verification", desc: "Users must confirm their email before sign-in.", fallback: true },
  { key: "mfaTotp", label: "Multi-factor (TOTP)", desc: "Users can enroll an authenticator app.", fallback: true },
  { key: "mfaRequiredForAdmins", label: "Multi-factor required for admins", desc: "Force admins to enroll MFA.", fallback: false },
  { key: "passkeys", label: "Passkeys", desc: "WebAuthn-based passwordless sign-in.", fallback: true },
  { key: "openSignup", label: "Open sign-up", desc: "Anyone can create an account.", fallback: true },
];

const isHttpUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const providerKind = (p: AuthProviderRow): "oauth" | "builtin" | "custom" | "saml" =>
  p.system ? (AUTH_OAUTH_IDS.has(p.id) ? "oauth" : "builtin") : "custom";

const mapAuthProviders = (map: Record<string, any> | undefined): AuthProviderRow[] => {
  const rows: AuthProviderRow[] = Object.entries(map ?? {}).map(([id, v]) => ({
    id,
    name: (v && v.name) || AUTH_PROVIDER_NAMES[id] || id,
    enabled: !!(v && v.enabled),
    configured: !!(v && v.configured),
    system: !!(v && v.system),
    clientId: (v && v.clientId) ?? null,
    hasSecret: !!(v && v.hasSecret),
    discoveryUrl: (v && v.discoveryUrl) ?? null,
  }));
  // Stable order: built-ins first, then alphabetical.
  rows.sort((a, b) => (a.system !== b.system ? (a.system ? -1 : 1) : a.id.localeCompare(b.id)));
  return rows;
};

export function AuthSettingsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const [providers, setProviders] = useState<AuthProviderRow[]>([]);
  const [policy, setPolicy] = useState<Record<string, boolean>>({});
  const [sessionLifetime, setSessionLifetime] = useState("30d");
  const [redirectText, setRedirectText] = useState("");
  const redirectSavedRef = useRef("");
  const [sessions, setSessions] = useState<{ id: string; user: string; device: string; ip: string; loc: string; created: string; last: string; current: boolean }[]>([]);
  const [configuring, setConfiguring] = useState<AuthProviderRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [workspace, setWorkspace] = useState<ApiTenant | null>(null);
  // SAML providers — separate from the OIDC/built-in list above. Loaded via
  // /api/admin/saml/providers, edited through SamlProviderDialog.
  const [samlProviders, setSamlProviders] = useState<ApiSamlProvider[]>([]);
  const [samlDialog, setSamlDialog] = useState<{ mode: "create" } | { mode: "edit"; row: ApiSamlProvider } | null>(null);
  const [confirmRemoveSaml, setConfirmRemoveSaml] = useState<{ id: string } | null>(null);
  const [availableRoles, setAvailableRoles] = useState<{ id: string; name: string }[]>([]);
  // First-load gate — drives the page skeleton until the auth config +
  // sessions + providers have all been fetched.
  const [loaded, setLoaded] = useState(false);

  const loadConfig = async () => {
    const cfg = await authAdminApi.config();
    const data = (cfg.data ?? {}) as ApiAuthConfig;
    setProviders(mapAuthProviders(data.providers as Record<string, any>));
    setPolicy((data.policy ?? {}) as Record<string, boolean>);
    setSessionLifetime(data.sessionLifetime || "30d");
    const text = (data.redirectUrls ?? []).join("\n");
    setRedirectText(text);
    redirectSavedRef.current = text;
  };

  const mapSession = (s: ApiSession) => ({
    id: s.id,
    user: s.userEmail,
    device: (s.userAgent ?? "unknown agent").slice(0, 48),
    ip: s.ipAddress ?? "—",
    loc: "—",
    created: new Date(s.createdAt).toISOString().replace("T", " ").slice(0, 19),
    last: fmtRelative(s.updatedAt ?? s.createdAt),
    current: !!s.current,
  });
  const loadSessions = async () => {
    const ss = await authAdminApi.sessions();
    setSessions((ss.data ?? []).map(mapSession));
  };

  const loadSamlProviders = async () => {
    try {
      const r = await samlAdminApi.list();
      setSamlProviders(r.data ?? []);
    } catch {
      // saml_providers table may not be migrated yet — empty list is fine
      setSamlProviders([]);
    }
  };

  const loadAvailableRoles = async () => {
    try {
      const r = await rolesApi.list();
      setAvailableRoles(
        (r.data ?? [])
          .filter((role: any) => !role.admin)
          .map((role: any) => ({ id: role.id, name: role.name })),
      );
    } catch {
      setAvailableRoles([]);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadConfig();
      } catch {
        // keep defaults — the providers list reflects what the worker actually has
      }
      if (cancelled) return;
      try {
        const ts = await tenantsApi.list();
        const active = ts.data.find((t) => t.id === ts.active) ?? ts.data[0] ?? null;
        if (!cancelled) setWorkspace(active);
      } catch {
        /* workspace endpoints panel just shows a placeholder slug */
      }
      if (cancelled) return;
      try {
        await loadSessions();
      } catch (e) {
        pushToast?.((e as Error).message);
      }
      if (cancelled) return;
      await Promise.allSettled([loadSamlProviders(), loadAvailableRoles()]);
      if (!cancelled) setLoaded(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushToast]);

  const removeSamlProvider = (id: string) => {
    setConfirmRemoveSaml({ id });
  };

  const doRemoveSamlProvider = async (id: string) => {
    try {
      await samlAdminApi.remove(id);
      setSamlProviders((arr) => arr.filter((r) => r.id !== id));
      pushToast?.("Provider deleted.");
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const toggleSamlEnabled = async (row: ApiSamlProvider, enabled: boolean) => {
    setSamlProviders((arr) => arr.map((r) => (r.id === row.id ? { ...r, enabled } : r)));
    try {
      await samlAdminApi.update(row.id, { enabled });
    } catch (e) {
      pushToast?.((e as Error).message);
      setSamlProviders((arr) => arr.map((r) => (r.id === row.id ? { ...r, enabled: !enabled } : r)));
    }
  };

  const toggleProvider = async (id: string, enabled: boolean) => {
    setProviders((arr) => arr.map((p) => (p.id === id ? { ...p, enabled } : p)));
    try {
      await authAdminApi.patch({ providers: { [id]: { enabled } } });
    } catch (e) {
      pushToast?.((e as Error).message);
      setProviders((arr) => arr.map((p) => (p.id === id ? { ...p, enabled: !enabled } : p)));
    }
  };

  const saveProviderConfig = async (id: string, patch: Record<string, unknown>) => {
    try {
      await authAdminApi.patch({ providers: { [id]: patch } });
      await loadConfig();
      pushToast?.(`${AUTH_PROVIDER_NAMES[id] ?? id} settings saved.`);
      setConfiguring(null);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const addProvider = async (id: string, patch: Record<string, unknown>) => {
    if (providers.some((p) => p.id === id)) {
      pushToast?.(`A provider with id "${id}" already exists.`);
      return;
    }
    try {
      await authAdminApi.patch({ providers: { [id]: { enabled: false, configured: false, system: false, ...patch } } });
      await loadConfig();
      pushToast?.(`Added provider "${id}".`);
      setAdding(false);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const setPolicyFlag = async (key: string, on: boolean) => {
    setPolicy((p) => ({ ...p, [key]: on }));
    try {
      await authAdminApi.patch({ policy: { [key]: on } });
    } catch (e) {
      pushToast?.((e as Error).message);
      setPolicy((p) => ({ ...p, [key]: !on }));
    }
  };

  const saveSessionLifetime = async (v: string) => {
    const prev = sessionLifetime;
    setSessionLifetime(v);
    try {
      await authAdminApi.patch({ sessionLifetime: v });
      pushToast?.(`Session lifetime set to ${v}.`);
    } catch (e) {
      pushToast?.((e as Error).message);
      setSessionLifetime(prev);
    }
  };

  const saveRedirects = async () => {
    const urls = redirectText.split("\n").map((s) => s.trim()).filter(Boolean);
    const joined = urls.join("\n");
    if (joined === redirectSavedRef.current) return;
    const bad = urls.find((u) => !isHttpUrl(u));
    if (bad) {
      pushToast?.(`"${bad}" isn't a valid URL — use e.g. https://app.example.com/auth/callback.`);
      return;
    }
    try {
      await authAdminApi.patch({ redirectUrls: urls });
      redirectSavedRef.current = joined;
      pushToast?.(`Saved ${urls.length} redirect URL${urls.length === 1 ? "" : "s"}.`);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const revokeSession = async (id: string) => {
    try {
      await authAdminApi.revokeSession(id);
      setSessions((arr) => arr.filter((s) => s.id !== id));
      pushToast?.(`Session ${id.slice(0, 6)}… revoked.`);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };
  const revokeOthers = async () => {
    try {
      const r = await authAdminApi.revokeOthers();
      pushToast?.(`Revoked ${r.removed} other session${r.removed === 1 ? "" : "s"}.`);
      await loadSessions();
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const userCount = new Set(sessions.map((s) => s.user)).size;

  // First whole-page fetch — auth config + sessions + providers still loading.
  if (!loaded) return <AuthSettingsSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader title="Authentication" description={<>Configure sign-in methods, MFA, and session policy. Tokens are signed with <span className="font-mono">$AUTH_SECRET</span>.</>} />
      <div className="grid grid-cols-[1fr_320px] items-start gap-4 max-[1280px]:grid-cols-1">
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
            <span className="text-[13px] font-medium">Providers</span>
            <div className="flex-1" />
            <Button size="sm" variant="outline" icon={I.Plus} onClick={() => setAdding(true)}>Add</Button>
          </div>
          {providers.length === 0 && <div className="border-b border-border px-4 py-3.5 text-[12.5px] text-muted-foreground">Couldn't load auth config.</div>}
          {providers.map((p) => {
            const lockedOff = !p.configured && !p.enabled;
            return (
            <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0">
              <span><I.Shield size={13} /></span>
              <div className="min-w-0 shrink-0 grow basis-[160px]">
                <div className="truncate text-[13px] font-medium">{p.name}</div>
                {p.clientId && <div className="truncate font-mono text-[11px] text-muted-foreground">{p.clientId}</div>}
                {!p.clientId && p.discoveryUrl && <div className="truncate font-mono text-[11px] text-muted-foreground">{p.discoveryUrl}</div>}
                {p.system && <div className="text-[11px] text-muted-foreground">built-in</div>}
                {p.enabled && !p.configured && <div className="text-[11px] text-destructive">enabled but not configured — won't appear on sign-in</div>}
              </div>
              {!p.configured && <Badge variant={p.enabled ? "destructive" : "secondary"}>not configured</Badge>}
              <Button size="sm" variant="ghost" onClick={() => setConfiguring(p)}>Configure</Button>
              <Switch
                checked={p.enabled}
                disabled={lockedOff}
                title={lockedOff ? "Configure this provider (add a Client ID) before enabling it" : undefined}
                onChange={(v) => toggleProvider(p.id, v)}
              />
            </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-3.5 overflow-hidden rounded-2xl border border-border bg-card text-card-foreground p-[18px]">
          <span className="text-[13px] font-medium">Policy</span>
          {POLICY_ROWS.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <div>
                <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{r.label}</div>
                <div className="text-[11.5px] text-muted-foreground">{r.desc}</div>
              </div>
              <Switch checked={policy[r.key] ?? r.fallback} onChange={(v) => setPolicyFlag(r.key, v)} />
            </div>
          ))}
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Session lifetime</label>
            <Select value={sessionLifetime} onChange={(v) => void saveSessionLifetime(v)} options={SESSION_LIFETIMES} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Allowed redirect URLs</label>
            <Textarea
              rows={3}
              value={redirectText}
              onChange={(e) => setRedirectText(e.target.value)}
              onBlur={() => void saveRedirects()}
              placeholder={"https://app.example.com/auth/callback\nhttp://localhost:5173/auth/callback"}
              className="font-mono h-auto text-xs"
            />
            <span className="text-[11.5px] text-muted-foreground">One URL per line — saved when you click away.</span>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.Shield size={13} />
          <span className="text-[13px] font-medium">SAML 2.0 SSO</span>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {samlProviders.length} provider{samlProviders.length === 1 ? "" : "s"}
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            icon={I.Plus}
            onClick={() => setSamlDialog({ mode: "create" })}
          >
            Add SAML
          </Button>
        </div>
        {samlProviders.length === 0 && (
          <div className="border-b border-border px-4 py-3.5 text-[12.5px] text-muted-foreground">
            No SAML providers configured. Add one to enable IdP-based SSO for this workspace's end-users.
          </div>
        )}
        {samlProviders.map((p) => (
          <div
            key={p.id}
            className="grid items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0 grid-cols-[24px_1fr_auto_auto_auto_auto]"
          >
            <span>
              <I.Shield size={13} />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-medium">
                {p.name}
                {p.idpTemplate && (
                  <Badge variant="secondary" className="ml-1.5">
                    {p.idpTemplate}
                  </Badge>
                )}
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {p.entityId}
              </div>
              {!p.idpCertSet && (
                <div className="text-[11px] text-destructive">
                  No signing cert stored — login will fail.
                </div>
              )}
            </div>
            <Badge variant="default">SAML</Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSamlDialog({ mode: "edit", row: p })}
            >
              Configure
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void removeSamlProvider(p.id)}
            >
              Delete
            </Button>
            <Switch
              checked={p.enabled}
              onChange={(v) => void toggleSamlEnabled(p, v)}
            />
          </div>
        ))}
      </div>

      <LdapConfigCard availableRoles={availableRoles} pushToast={pushToast} />

      {(() => {
        const slug = workspace?.slug ?? "<workspace>";
        const base = apiOrigin();
        const authBase = `${base}/api/t/${slug}/auth`;
        const oauthIds = providers
          .filter((p) => p.enabled && AUTH_OAUTH_IDS.has(p.id))
          .map((p) => p.id);
        const Row = ({ label, value }: { label: string; value: string }) => (
          <div className="grid items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0 grid-cols-[1fr_auto]">
            <div className="min-w-0">
              <div className="text-xs font-medium">{label}</div>
              <div className="truncate font-mono text-[11.5px] text-muted-foreground">{value}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void copyText(value, () => pushToast?.("Copied."))}>Copy</Button>
          </div>
        );
        const Snippet = ({ label, code }: { label: string; code: string }) => (
          <div className="flex flex-col gap-1.5">
            <div className="mb-1 flex items-center gap-2">
              <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{label}</span>
              <div className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => void copyText(code, () => pushToast?.("Copied."))}>Copy</Button>
            </div>
            <pre className="m-0 overflow-x-auto whitespace-pre rounded-lg bg-muted p-3 font-mono text-[11.5px]">{code}</pre>
          </div>
        );
        const sdkCode =
`import { createClient } from "@workeros/client";

const wk = createClient({
  url: "${base}",
  workspace: "${slug}",
  token: localStorage.getItem("wk_token") ?? undefined,
});

await wk.auth.signIn({ email, password });           // or signUp / signInSocial / signInMagicLink
localStorage.setItem("wk_token", wk.auth.getToken()!);

const posts = await wk.from("posts").list();          // data API — the app session is recognised`;
        const curlCode =
`# discover which providers to render (no auth, no secrets)
curl ${authBase}/providers

# sign in (returns { token, user })
curl -X POST ${authBase}/sign-in/email \\
  -H 'content-type: application/json' \\
  -d '{"email":"user@example.com","password":"…"}'

# use the token on later calls
curl ${authBase}/get-session -H 'authorization: Bearer <token>'`;
        return (
          <div className="flex flex-col gap-3.5 overflow-hidden rounded-2xl border border-border bg-card text-card-foreground p-[18px]">
            <div>
              <span className="text-[13px] font-medium">Workspace auth API <span className="font-normal text-muted-foreground">· auth as a service</span></span>
              <div className="mt-[3px] text-xs text-muted-foreground">End-users of the app built on this workspace sign in here — separate from the admin login. Configure providers above.</div>
            </div>
            <div>
              <Row label="Auth base URL" value={authBase} />
              <Row label="Provider discovery" value={`${authBase}/providers`} />
              <Row label="Sign-up / sign-in / get-session / sign-out" value={`${authBase}/{sign-up|sign-in}/email · ${authBase}/get-session · ${authBase}/sign-out`} />
              {oauthIds.map((id) => (
                <Row key={id} label={`OAuth redirect URI to register with ${AUTH_PROVIDER_NAMES[id] ?? id}`} value={`${authBase}/callback/${id}`} />
              ))}
            </div>
            <Snippet label="Frontend SDK" code={sdkCode} />
            <Snippet label="curl" code={curlCode} />
          </div>
        );
      })()}

      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.Activity size={13} />
          <span className="text-[13px] font-medium">Active sessions</span>
          <span className="font-mono text-[11.5px] text-muted-foreground">{sessions.length} session{sessions.length === 1 ? "" : "s"} · {userCount} user{userCount === 1 ? "" : "s"}</span>
          <div className="flex-1" />
          <Button size="sm" variant="outline" icon={I.LogOut} onClick={revokeOthers}>Revoke others</Button>
        </div>
        <Table className="[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground">
          <TableHeader><TableRow><TableHead>User</TableHead><TableHead>Device</TableHead><TableHead>Location</TableHead><TableHead>IP</TableHead><TableHead>Created</TableHead><TableHead>Last seen</TableHead><TableHead className="sticky right-0 bg-card" /></TableRow></TableHeader>
          <TableBody>
            {sessions.length === 0 && <TableRow><TableCell colSpan={7} className="text-muted-foreground">No active sessions.</TableCell></TableRow>}
            {sessions.map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.user}{s.current && <Badge variant="default" className="ml-1.5">current</Badge>}</TableCell>
                <TableCell className="font-mono text-[11.5px]">{s.device}</TableCell>
                <TableCell>{s.loc}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{s.ip}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{s.created}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{s.last}</TableCell>
                <TableCell className="sticky right-0 bg-card text-right">{!s.current && <Button size="sm" variant="ghost" onClick={() => void revokeSession(s.id)}>Revoke</Button>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {configuring && (
        <ProviderConfigDialog
          provider={configuring}
          kind={providerKind(configuring)}
          onClose={() => setConfiguring(null)}
          onSave={(patch) => void saveProviderConfig(configuring.id, patch)}
        />
      )}
      {adding && (
        <AddProviderDialog
          existingIds={providers.map((p) => p.id)}
          onClose={() => setAdding(false)}
          onAdd={(id, patch) => void addProvider(id, patch)}
        />
      )}
      {samlDialog && (
        <SamlProviderDialog
          existing={samlDialog.mode === "edit" ? samlDialog.row : null}
          workspaceSlug={workspace?.slug ?? ""}
          availableRoles={availableRoles}
          pushToast={pushToast}
          onClose={() => setSamlDialog(null)}
          onSaved={(saved) => {
            setSamlProviders((arr) => {
              const i = arr.findIndex((r) => r.id === saved.id);
              if (i === -1) return [...arr, saved];
              const next = arr.slice();
              next[i] = saved;
              return next;
            });
            setSamlDialog(null);
          }}
        />
      )}
      <ConfirmDialog
        open={!!confirmRemoveSaml}
        title="Delete SAML provider?"
        description="External identity rows are kept as an audit trail."
        actionLabel="Delete"
        destructive
        onConfirm={async () => {
          if (confirmRemoveSaml) await doRemoveSamlProvider(confirmRemoveSaml.id);
          setConfirmRemoveSaml(null);
        }}
        onCancel={() => setConfirmRemoveSaml(null)}
      />
    </div>
  );
}

function ProviderConfigDialog({ provider, kind, onClose, onSave }: {
  provider: AuthProviderRow;
  kind: "oauth" | "builtin" | "custom";
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [enabled, setEnabled] = useState(provider.enabled);
  const [name, setName] = useState(provider.name ?? "");
  const [clientId, setClientId] = useState(provider.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [discoveryUrl, setDiscoveryUrl] = useState(provider.discoveryUrl ?? "");

  // A secret is "available" if one is already stored, or the admin just typed one.
  const hasSecret = !!provider.hasSecret || !!clientSecret.trim();
  const discoveryBad = !!discoveryUrl.trim() && !isHttpUrl(discoveryUrl.trim());
  const valid = kind === "custom" ? name.trim().length >= 2 && !discoveryBad : !discoveryBad;

  const submit = () => {
    if (!valid) return;
    const hasClientId = !!clientId.trim();
    // Fully configured = has both id AND a secret (stored or freshly entered).
    const fullyConfigured = hasClientId && hasSecret;
    const patch: Record<string, unknown> = {};
    if (kind === "oauth" || kind === "custom") {
      patch.clientId = clientId.trim() || null;
      // Only send the secret when the admin actually typed one — leaving the
      // field blank keeps the stored secret untouched.
      if (clientSecret.trim()) patch.clientSecret = clientSecret.trim();
      patch.configured = fullyConfigured;
      patch.enabled = fullyConfigured ? enabled : false;
      if (kind === "custom") {
        patch.name = name.trim();
        patch.discoveryUrl = discoveryUrl.trim() || null;
      }
    } else {
      patch.enabled = enabled;
    }
    onSave(patch);
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">Configure {provider.name}</DialogTitle>
          <DialogDescription className="text-[12.5px]">
            {kind === "oauth" ? "OAuth 2.0 / OIDC sign-in provider." : kind === "custom" ? "Custom OpenID Connect provider." : "Built-in sign-in method."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-[18px]">
          {(() => {
            const blocked = (kind === "oauth" || kind === "custom") && !(clientId.trim() && hasSecret);
            return (
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Enabled</div>
                  <div className="text-[11.5px] text-muted-foreground">{blocked ? "Add a Client ID and secret below first." : "Show this option on the sign-in screen."}</div>
                </div>
                <Switch checked={enabled && !blocked} disabled={blocked} title={blocked ? "Add a Client ID and secret first" : undefined} onChange={setEnabled} />
              </div>
            );
          })()}
          {kind === "custom" && (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Display name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme SSO" />
            </div>
          )}
          {(kind === "oauth" || kind === "custom") && (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Client ID</label>
              <Input className="font-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123456789-abc.apps.example.com" />
            </div>
          )}
          {(kind === "oauth" || kind === "custom") && (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Client secret {provider.hasSecret && <span className="text-muted-foreground">· stored, leave blank to keep</span>}</label>
              <Input type="password" className="font-mono" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={provider.hasSecret ? "••••••••••••••••" : "paste from the provider"} autoComplete="new-password" />
            </div>
          )}
          {kind === "custom" && (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Discovery URL <span className="text-muted-foreground">(optional)</span></label>
              <Input className="font-mono" value={discoveryUrl} onChange={(e) => setDiscoveryUrl(e.target.value)} placeholder="https://issuer.example.com/.well-known/openid-configuration" />
              {discoveryBad && <span className="text-[11.5px] text-destructive">Must be a full http(s) URL.</span>}
            </div>
          )}
          {(kind === "oauth" || kind === "custom") && (
            <div className="text-[11.5px] leading-[1.5] text-muted-foreground">
              The client secret is encrypted at rest. If you leave both fields blank, sign-in falls back to the{" "}
              <span className="font-mono">OAUTH_{provider.id.toUpperCase()}_CLIENT_ID</span> /{" "}
              <span className="font-mono">_CLIENT_SECRET</span> environment variables. Register{" "}
              <span className="font-mono">{"{app-url}"}/api/t/{"{workspace}"}/auth/callback/{provider.id}</span> as the redirect URI with the provider.
            </div>
          )}
          {kind === "builtin" && (
            <div className="text-[11.5px] leading-[1.5] text-muted-foreground">
              {provider.id === "email"
                ? "Email + password is always available — toggle it off to hide the form from the sign-in screen."
                : provider.id === "passkey"
                  ? "Users enrol a passkey after signing in once with another method."
                  : "Sends a one-time sign-in link by email — requires a configured email adapter (set RESEND_API_KEY + EMAIL_FROM)."}
            </div>
          )}
        </div>
        <DialogFooter className="border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon={I.Check} disabled={!valid} onClick={submit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddProviderDialog({ existingIds, onClose, onAdd }: {
  existingIds: string[];
  onClose: () => void;
  onAdd: (id: string, patch: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [discoveryUrl, setDiscoveryUrl] = useState("");
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const idTaken = !!slug && existingIds.includes(slug);
  const discoveryBad = !!discoveryUrl.trim() && !isHttpUrl(discoveryUrl.trim());
  const valid = slug.length >= 2 && !idTaken && !discoveryBad;

  const submit = () => {
    if (!valid) return;
    onAdd(slug, {
      name: name.trim(),
      clientId: clientId.trim() || null,
      discoveryUrl: discoveryUrl.trim() || null,
      configured: !!clientId.trim(),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">Add OIDC provider</DialogTitle>
          <DialogDescription className="text-[12.5px]">Register a custom OpenID Connect identity provider.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-[18px]">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Display name</label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme SSO" />
            <span className="font-mono text-[11px] text-muted-foreground">
              id: <span className={idTaken ? "text-destructive" : "text-foreground"}>{slug || "—"}</span>
              {idTaken && <span className="text-destructive"> · already exists</span>}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Client ID <span className="text-muted-foreground">(optional)</span></label>
            <Input className="font-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="abc123" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Discovery URL <span className="text-muted-foreground">(optional)</span></label>
            <Input className="font-mono" value={discoveryUrl} onChange={(e) => setDiscoveryUrl(e.target.value)} placeholder="https://issuer.example.com/.well-known/openid-configuration" />
            {discoveryBad && <span className="text-[11.5px] text-destructive">Must be a full http(s) URL.</span>}
          </div>
          <div className="text-[11.5px] leading-[1.5] text-muted-foreground">
            The provider is added disabled. Set its client secret server-side, then enable it here.
          </div>
        </div>
        <DialogFooter className="items-center border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3 sm:justify-start">
          <span className="text-xs text-muted-foreground">{valid ? "Will be added disabled." : idTaken ? "Pick a unique name." : "Enter a name to continue."}</span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon={I.Plus} disabled={!valid} onClick={submit}>Add provider</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
