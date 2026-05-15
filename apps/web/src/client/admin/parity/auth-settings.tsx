// @ts-nocheck
import { useEffect, useRef, useState } from "react";
import { I } from "../icons";
import { Badge, Button, IconButton, PageHeader, Switch } from "../ui";
import { Select } from "../select";
import {
  authAdminApi,
  tenantsApi,
  type ApiAuthConfig,
  type ApiSession,
  type ApiTenant,
} from "../api";
import { apiOrigin, copyText, fmtRelative } from "./_shared";

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

const providerKind = (p: AuthProviderRow): "oauth" | "builtin" | "custom" =>
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
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushToast]);

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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader title="Authentication" description={<>Configure sign-in methods, MFA, and session policy. Tokens are signed with <span className="font-mono">$AUTH_SECRET</span>.</>} />
      <div className="split">
        <div className="card">
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Providers</span>
            <div className="spacer" />
            <Button size="sm" variant="outline" icon={I.Plus} onClick={() => setAdding(true)}>Add</Button>
          </div>
          {providers.length === 0 && <div className="card-section muted" style={{ fontSize: 12.5 }}>Couldn't load auth config.</div>}
          {providers.map((p) => {
            const lockedOff = !p.configured && !p.enabled;
            return (
            <div key={p.id} className="schema-row" style={{ gridTemplateColumns: "24px 1fr auto auto auto" }}>
              <span><I.Shield size={13} /></span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</div>
                {p.clientId && <div className="font-mono muted" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{p.clientId}</div>}
                {!p.clientId && p.discoveryUrl && <div className="font-mono muted" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{p.discoveryUrl}</div>}
                {p.system && <div className="muted" style={{ fontSize: 11 }}>built-in</div>}
                {p.enabled && !p.configured && <div style={{ fontSize: 11, color: "var(--destructive)" }}>enabled but not configured — won't appear on sign-in</div>}
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
        <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Policy</span>
          {POLICY_ROWS.map((r) => (
            <div key={r.key} className="field-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <div>
                <div className="field-label">{r.label}</div>
                <div className="field-hint">{r.desc}</div>
              </div>
              <Switch checked={policy[r.key] ?? r.fallback} onChange={(v) => setPolicyFlag(r.key, v)} />
            </div>
          ))}
          <div className="field" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <label className="field-label">Session lifetime</label>
            <Select value={sessionLifetime} onChange={(v) => void saveSessionLifetime(v)} options={SESSION_LIFETIMES} />
          </div>
          <div className="field">
            <label className="field-label">Allowed redirect URLs</label>
            <textarea
              className="input"
              rows={3}
              value={redirectText}
              onChange={(e) => setRedirectText(e.target.value)}
              onBlur={() => void saveRedirects()}
              placeholder={"https://app.example.com/auth/callback\nhttp://localhost:5173/auth/callback"}
              style={{ height: "auto", fontFamily: "Geist Mono, monospace", fontSize: 12 }}
            />
            <span className="field-hint">One URL per line — saved when you click away.</span>
          </div>
        </div>
      </div>

      {(() => {
        const slug = workspace?.slug ?? "<workspace>";
        const base = apiOrigin();
        const authBase = `${base}/api/t/${slug}/auth`;
        const oauthIds = providers
          .filter((p) => p.enabled && AUTH_OAUTH_IDS.has(p.id))
          .map((p) => p.id);
        const Row = ({ label, value }: { label: string; value: string }) => (
          <div className="schema-row" style={{ gridTemplateColumns: "1fr auto" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500 }}>{label}</div>
              <div className="font-mono muted" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void copyText(value, () => pushToast?.("Copied."))}>Copy</Button>
          </div>
        );
        const Snippet = ({ label, code }: { label: string; code: string }) => (
          <div className="field">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span className="field-label" style={{ margin: 0 }}>{label}</span>
              <div className="spacer" />
              <Button size="sm" variant="ghost" onClick={() => void copyText(code, () => pushToast?.("Copied."))}>Copy</Button>
            </div>
            <pre className="font-mono" style={{ margin: 0, padding: 12, background: "var(--muted)", borderRadius: 8, fontSize: 11.5, overflowX: "auto", whiteSpace: "pre" }}>{code}</pre>
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
          <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 500 }}>Workspace auth API <span className="muted" style={{ fontWeight: 400 }}>· auth as a service</span></span>
              <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>End-users of the app built on this workspace sign in here — separate from the admin login. Configure providers above.</div>
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

      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.Activity size={13} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Active sessions</span>
          <span className="muted font-mono" style={{ fontSize: 11.5 }}>{sessions.length} session{sessions.length === 1 ? "" : "s"} · {userCount} user{userCount === 1 ? "" : "s"}</span>
          <div className="spacer" />
          <Button size="sm" variant="outline" icon={I.LogOut} onClick={revokeOthers}>Revoke others</Button>
        </div>
        <div className="table-scroll">
        <table className="table">
          <thead><tr><th>User</th><th>Device</th><th>Location</th><th>IP</th><th>Created</th><th>Last seen</th><th></th></tr></thead>
          <tbody>
            {sessions.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 14 }}>No active sessions.</td></tr>}
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{s.user}{s.current && <Badge variant="default" style={{ marginLeft: 6 }}>current</Badge>}</td>
                <td className="font-mono" style={{ fontSize: 11.5 }}>{s.device}</td>
                <td>{s.loc}</td>
                <td className="font-mono muted" style={{ fontSize: 11.5 }}>{s.ip}</td>
                <td className="muted font-mono" style={{ fontSize: 11.5 }}>{s.created}</td>
                <td className="muted font-mono" style={{ fontSize: 11.5 }}>{s.last}</td>
                <td style={{ textAlign: "right" }}>{!s.current && <Button size="sm" variant="ghost" onClick={() => void revokeSession(s.id)}>Revoke</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
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
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, width: "92vw" }}>
        <div className="dialog-head">
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>Configure {provider.name}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
              {kind === "oauth" ? "OAuth 2.0 / OIDC sign-in provider." : kind === "custom" ? "Custom OpenID Connect provider." : "Built-in sign-in method."}
            </div>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>
        <div className="dialog-body">
          {(() => {
            const blocked = (kind === "oauth" || kind === "custom") && !(clientId.trim() && hasSecret);
            return (
              <div className="field-row">
                <div>
                  <div className="field-label">Enabled</div>
                  <div className="field-hint">{blocked ? "Add a Client ID and secret below first." : "Show this option on the sign-in screen."}</div>
                </div>
                <Switch checked={enabled && !blocked} disabled={blocked} title={blocked ? "Add a Client ID and secret first" : undefined} onChange={setEnabled} />
              </div>
            );
          })()}
          {kind === "custom" && (
            <div className="field">
              <label className="field-label">Display name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme SSO" />
            </div>
          )}
          {(kind === "oauth" || kind === "custom") && (
            <div className="field">
              <label className="field-label">Client ID</label>
              <input className="input font-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123456789-abc.apps.example.com" />
            </div>
          )}
          {(kind === "oauth" || kind === "custom") && (
            <div className="field">
              <label className="field-label">Client secret {provider.hasSecret && <span className="muted">· stored, leave blank to keep</span>}</label>
              <input type="password" className="input font-mono" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={provider.hasSecret ? "••••••••••••••••" : "paste from the provider"} autoComplete="new-password" />
            </div>
          )}
          {kind === "custom" && (
            <div className="field">
              <label className="field-label">Discovery URL <span className="muted">(optional)</span></label>
              <input className="input font-mono" value={discoveryUrl} onChange={(e) => setDiscoveryUrl(e.target.value)} placeholder="https://issuer.example.com/.well-known/openid-configuration" />
              {discoveryBad && <span className="field-hint" style={{ color: "var(--destructive)" }}>Must be a full http(s) URL.</span>}
            </div>
          )}
          {(kind === "oauth" || kind === "custom") && (
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              The client secret is encrypted at rest. If you leave both fields blank, sign-in falls back to the{" "}
              <span className="font-mono">OAUTH_{provider.id.toUpperCase()}_CLIENT_ID</span> /{" "}
              <span className="font-mono">_CLIENT_SECRET</span> environment variables. Register{" "}
              <span className="font-mono">{"{app-url}"}/api/t/{"{workspace}"}/auth/callback/{provider.id}</span> as the redirect URI with the provider.
            </div>
          )}
          {kind === "builtin" && (
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              {provider.id === "email"
                ? "Email + password is always available — toggle it off to hide the form from the sign-in screen."
                : provider.id === "passkey"
                  ? "Users enrol a passkey after signing in once with another method."
                  : "Sends a one-time sign-in link by email — requires a configured email adapter (set RESEND_API_KEY + EMAIL_FROM)."}
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <div className="spacer" />
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon={I.Check} disabled={!valid} onClick={submit}>Save</Button>
        </div>
      </div>
    </div>
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
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, width: "92vw" }}>
        <div className="dialog-head">
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>Add OIDC provider</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>Register a custom OpenID Connect identity provider.</div>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>
        <div className="dialog-body">
          <div className="field">
            <label className="field-label">Display name</label>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme SSO" />
            <span className="field-hint font-mono" style={{ fontSize: 11 }}>
              id: <span style={{ color: idTaken ? "var(--destructive)" : "var(--foreground)" }}>{slug || "—"}</span>
              {idTaken && <span style={{ color: "var(--destructive)" }}> · already exists</span>}
            </span>
          </div>
          <div className="field">
            <label className="field-label">Client ID <span className="muted">(optional)</span></label>
            <input className="input font-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="abc123" />
          </div>
          <div className="field">
            <label className="field-label">Discovery URL <span className="muted">(optional)</span></label>
            <input className="input font-mono" value={discoveryUrl} onChange={(e) => setDiscoveryUrl(e.target.value)} placeholder="https://issuer.example.com/.well-known/openid-configuration" />
            {discoveryBad && <span className="field-hint" style={{ color: "var(--destructive)" }}>Must be a full http(s) URL.</span>}
          </div>
          <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            The provider is added disabled. Set its client secret server-side, then enable it here.
          </div>
        </div>
        <div className="dialog-foot">
          <span className="muted" style={{ fontSize: 12 }}>{valid ? "Will be added disabled." : idTaken ? "Pick a unique name." : "Enter a name to continue."}</span>
          <div className="spacer" />
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon={I.Plus} disabled={!valid} onClick={submit}>Add provider</Button>
        </div>
      </div>
    </div>
  );
}
