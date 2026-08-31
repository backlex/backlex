import type { PushToast } from "../../types";
import { useEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Checkbox } from "@backlex/ui/components/checkbox";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Textarea } from "@backlex/ui/components/textarea";
import { Card } from "@backlex/ui/components/card";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { I } from "../../icons";
import { Badge, Button, IconButton, PageHeader, Switch } from "../../ui";
import { useUrlTab } from "../../use-url-tab";
import { Select } from "../../select";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import {
  authAdminApi,
  tenantsApi,
  rolesApi,
  samlAdminApi,
  oidcAdminApi,
  type ApiAuthConfig,
  type ApiOidcProvider,
  type ApiSamlProvider,
  type ApiSession,
  type ApiTenant,
  type OidcProviderCreate,
} from "../../api";
import { ConfirmDialog } from "../../sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
import { apiOrigin, copyText, fmtRelative } from "../_shared";
import { SamlProviderDialog } from "./saml-provider-dialog";
import { OidcProviderDialog } from "./oidc-provider-dialog";
import { ScimCard } from "./scim-card";
import { ThirdPartyAuthCard } from "./third-party-auth-card";
import { AuthHooksCard } from "./auth-hooks-card";
import { CaptchaCard } from "./captcha-card";
import { SigningKeysCard } from "./signing-keys-card";
import { OAuthClientsCard } from "./oauth-clients-card";
import { LdapConfigCard } from "./ldap-config-card";
import { shouldWarnTwoFactorBypass } from "./mfa-bypass";
import { AuthSessionsTabSkeleton, AuthSettingsSkeleton, AuthSsoTabSkeleton } from "../../page-skeletons";

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
const appUrlPlaceholder = "{app-url}";
const workspacePlaceholder = "{workspace}";
const POLICY_ROWS: { key: string; label: string; desc: string; fallback: boolean }[] = [
  { key: "requireEmailVerification", label: "Require email verification", desc: "Users must confirm their email before sign-in.", fallback: false },
  { key: "openSignup", label: "Open sign-up", desc: "Anyone can create an account. When off, only the first user and invited addresses can sign up.", fallback: false },
];

/**
 * The page is five panels, not one scroll. Grouped by the question the admin
 * came to answer rather than by which table backs the card:
 *
 *  - sign-in   how somebody proves who they are, and who is allowed to try
 *  - sso       the enterprise directories that answer that for us
 *  - tokens    the JWT story — who signs ours, who we mint for, whose we trust
 *  - api       how an application talks to any of it
 *  - sessions  who is signed in right now
 */
const AUTH_TABS = ["sign-in", "sso", "tokens", "api", "sessions"] as const;
type AuthTab = (typeof AUTH_TABS)[number];

const isHttpUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

// No `"saml"` arm: SAML providers are managed on their own page and never
// reach this dialog, so declaring it here only widened the return type past
// what the function can produce — and past what `ProviderConfigDialog` accepts.
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

export function AuthSettingsPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  // `/authentication/:tab`. An unknown segment lands on the first panel rather
  // than an empty page — see `useUrlTab`.
  const [active, setTab] = useUrlTab(AUTH_TABS, "sign-in");
  const [providers, setProviders] = useState<AuthProviderRow[]>([]);
  const [policy, setPolicy] = useState<Record<string, boolean>>({});
  const [sessionLifetime, setSessionLifetime] = useState("30d");
  const [redirectText, setRedirectText] = useState("");
  const redirectSavedRef = useRef("");
  const [sessions, setSessions] = useState<{ id: string; user: string; device: string; ip: string; loc: string; created: string; last: string; current: boolean }[]>([]);
  // Sessions can run into the hundreds; cap the table and expand on demand so the
  // page doesn't scroll forever (especially on mobile).
  const SESSIONS_PAGE = 8;
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [configuring, setConfiguring] = useState<AuthProviderRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [workspace, setWorkspace] = useState<ApiTenant | null>(null);
  // SAML providers — separate from the OIDC/built-in list above. Loaded via
  // /api/admin/saml/providers, edited through SamlProviderDialog.
  const [samlProviders, setSamlProviders] = useState<ApiSamlProvider[]>([]);
  const [samlDialog, setSamlDialog] = useState<{ mode: "create" } | { mode: "edit"; row: ApiSamlProvider } | null>(null);
  const [confirmRemoveSaml, setConfirmRemoveSaml] = useState<{ id: string } | null>(null);
  // Generic OIDC / OAuth2 providers — the `oidc_providers` table, edited
  // through OidcProviderDialog. Sibling of the SAML block above.
  const [oidcProviders, setOidcProviders] = useState<ApiOidcProvider[]>([]);
  const [oidcDialog, setOidcDialog] = useState<{ mode: "create" } | { mode: "edit"; row: ApiOidcProvider } | null>(null);
  const [confirmRemoveOidc, setConfirmRemoveOidc] = useState<{ id: string } | null>(null);
  // Pending "enable a 2FA-bypassing provider" confirmation (magic / emailOtp).
  const [confirmBypass, setConfirmBypass] = useState<{ id: string } | null>(null);
  const [availableRoles, setAvailableRoles] = useState<{ id: string; name: string }[]>([]);
  // First-load gate — drives the page skeleton until the auth config and the
  // active workspace have been fetched. Everything else is per-tab (below).
  const [loaded, setLoaded] = useState(false);
  // Per-tab gates for the fetches that only one panel needs.
  const [ssoLoaded, setSsoLoaded] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);

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

  const loadOidcProviders = async () => {
    try {
      const r = await oidcAdminApi.list();
      setOidcProviders(r.data ?? []);
    } catch {
      // oidc_providers table may not be migrated yet — empty list is fine
      setOidcProviders([]);
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

  // Eager: the two fetches more than one panel reads. The auth config backs the
  // Sign-in panel and the redirect URIs on the API panel; the workspace backs
  // the sign-up note, both SSO dialogs, and every URL on the API panel.
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
        const current = ts.data.find((t) => t.id === ts.active) ?? ts.data[0] ?? null;
        if (!cancelled) setWorkspace(current);
      } catch {
        /* workspace endpoints panel just shows a placeholder slug */
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Lazy: everything a single panel needs is fetched the first time that panel
  // opens. Opening Authentication used to cost ~13 requests, almost all of them
  // for cards the admin never scrolled to. `fetched` keeps a tab revisit — and
  // StrictMode's double-invoke — from firing the same request twice.
  const fetched = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!loaded) return;
    const once = (key: string, run: () => Promise<void>) => {
      if (fetched.current.has(key)) return;
      fetched.current.add(key);
      void run();
    };
    if (active === "sso") {
      once("sso", async () => {
        await Promise.allSettled([loadSamlProviders(), loadOidcProviders()]);
        setSsoLoaded(true);
      });
    }
    // The role picker is shared by the SSO dialogs, SCIM, LDAP and the
    // third-party issuers on Tokens — fetched once, for whichever opens first.
    if (active === "sso" || active === "tokens") once("roles", loadAvailableRoles);
    if (active === "sessions") {
      once("sessions", async () => {
        try {
          await loadSessions();
        } catch (e) {
          pushToast?.((e as Error).message);
        }
        setSessionsLoaded(true);
      });
    }
  }, [active, loaded, pushToast]);

  const removeSamlProvider = (id: string) => {
    setConfirmRemoveSaml({ id });
  };

  const doRemoveSamlProvider = async (id: string) => {
    try {
      await samlAdminApi.remove(id);
      setSamlProviders((arr) => arr.filter((r) => r.id !== id));
      pushToast?.(t`Provider deleted.`);
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

  const doRemoveOidcProvider = async (id: string) => {
    const snapshot = oidcProviders;
    setOidcProviders((arr) => arr.filter((r) => r.id !== id));
    try {
      await oidcAdminApi.remove(id);
      pushToast?.(t`Provider deleted.`);
    } catch (e) {
      setOidcProviders(snapshot);
      pushToast?.((e as Error).message);
    }
  };

  const toggleOidcEnabled = async (row: ApiOidcProvider, enabled: boolean) => {
    setOidcProviders((arr) => arr.map((r) => (r.id === row.id ? { ...r, enabled } : r)));
    try {
      await oidcAdminApi.update(row.id, { enabled });
    } catch (e) {
      pushToast?.((e as Error).message);
      setOidcProviders((arr) => arr.map((r) => (r.id === row.id ? { ...r, enabled: !enabled } : r)));
    }
  };

  /**
   * Create/update from the dialog. The row is applied to the list (and the
   * dialog closed) before the request goes out, then reconciled with the
   * server's own view; any failure restores the pre-mutation snapshot.
   *
   * The optimistic row deliberately derives `hasClientSecret` from "was one
   * already stored, or did the admin just type one" — the API never echoes the
   * secret back, so guessing `true` unconditionally would make an edit that
   * failed server-side look credentialed.
   */
  const saveOidcProvider = async (body: OidcProviderCreate, existing: ApiOidcProvider | null) => {
    const snapshot = oidcProviders;
    setOidcDialog(null);
    const optimistic: ApiOidcProvider = {
      id: existing?.id ?? `optimistic-${body.slug}`,
      name: body.name,
      slug: body.slug,
      clientId: body.clientId,
      hasClientSecret: !!body.clientSecret || !!existing?.hasClientSecret,
      discoveryUrl: body.discoveryUrl ?? null,
      authorizationUrl: body.authorizationUrl ?? null,
      tokenUrl: body.tokenUrl ?? null,
      userInfoUrl: body.userInfoUrl ?? null,
      scopes: body.scopes ?? existing?.scopes ?? ["openid", "profile", "email"],
      pkce: body.pkce ?? true,
      emailClaim: body.emailClaim ?? null,
      groupsClaim: body.groupsClaim ?? null,
      defaultRoleId: existing?.defaultRoleId ?? null,
      groupsToRoles: existing?.groupsToRoles ?? null,
      linkByVerifiedEmail: body.linkByVerifiedEmail ?? false,
      enabled: body.enabled ?? true,
      createdAt: existing?.createdAt ?? null,
      updatedAt: null,
    };
    setOidcProviders((arr) =>
      existing
        ? arr.map((r) => (r.id === existing.id ? optimistic : r))
        : [optimistic, ...arr],
    );
    try {
      const res = existing
        ? await oidcAdminApi.update(existing.id, body)
        : await oidcAdminApi.create(body);
      setOidcProviders((arr) => arr.map((r) => (r.id === optimistic.id ? res.data : r)));
      pushToast?.(existing ? t`Provider saved.` : t`Provider created.`);
    } catch (e) {
      setOidcProviders(snapshot);
      pushToast?.((e as Error).message);
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

  // Magic-link and email-OTP both bypass the TOTP second factor (better-auth
  // only gates password sign-in). Authenticator-app 2FA is always available on
  // the instance, so enabling one of these always weakens it — surface a
  // warning and only proceed on confirm. Disabling, and every other provider,
  // toggles straight through.
  const requestToggleProvider = (id: string, enabled: boolean) => {
    if (shouldWarnTwoFactorBypass(id, enabled)) {
      setConfirmBypass({ id });
      return;
    }
    void toggleProvider(id, enabled);
  };

  const saveProviderConfig = async (id: string, patch: Record<string, unknown>) => {
    try {
      await authAdminApi.patch({ providers: { [id]: patch } });
      await loadConfig();
      pushToast?.(t`${AUTH_PROVIDER_NAMES[id] ?? id} settings saved.`);
      setConfiguring(null);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const addProvider = async (id: string, patch: Record<string, unknown>) => {
    if (providers.some((p) => p.id === id)) {
      pushToast?.(t`A provider with id "${id}" already exists.`);
      return;
    }
    try {
      await authAdminApi.patch({ providers: { [id]: { enabled: false, configured: false, system: false, ...patch } } });
      await loadConfig();
      pushToast?.(t`Added provider "${id}".`);
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
      pushToast?.(t`Session lifetime set to ${v}.`);
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
      pushToast?.(t`"${bad}" isn't a valid URL — use e.g. https://app.example.com/auth/callback.`);
      return;
    }
    try {
      await authAdminApi.patch({ redirectUrls: urls });
      redirectSavedRef.current = joined;
      pushToast?.(t`Saved ${urls.length} redirect URL${urls.length === 1 ? "" : "s"}.`);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const revokeSession = async (id: string) => {
    try {
      await authAdminApi.revokeSession(id);
      setSessions((arr) => arr.filter((s) => s.id !== id));
      pushToast?.(t`Session ${id.slice(0, 6)}… revoked.`);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };
  /**
   * Sign out every other device.
   *
   * Optimistic: the rows go the moment the operator confirms, and come back if
   * the call fails. `current` is the flag the server keeps this session by, so
   * the client can predict the outcome exactly rather than waiting on a
   * refetch to redraw the table.
   */
  const revokeOthers = async (alsoKeys: boolean) => {
    const snapshot = sessions;
    setSessions((arr) => arr.filter((sess) => sess.current));
    try {
      const r = await authAdminApi.revokeOthers({ apiKeys: alsoKeys });
      const signedOut = t`Revoked ${r.removed} other session${r.removed === 1 ? "" : "s"}.`;
      // The count is only worth saying when there is something to act on, and
      // it has to be said out loud when it was NOT revoked — that is the gap
      // this whole flow exists to make visible.
      pushToast?.(
        r.apiKeysRevoked > 0
          ? `${signedOut} ${t`Also revoked ${r.apiKeysRevoked} API key${r.apiKeysRevoked === 1 ? "" : "s"}.`}`
          : r.apiKeys > 0
            ? `${signedOut} ${t`${r.apiKeys} API key${r.apiKeys === 1 ? "" : "s"} still grant access — API keys are not sessions.`}`
            : signedOut,
      );
      await loadSessions();
    } catch (e) {
      setSessions(snapshot);
      pushToast?.((e as Error).message);
    }
  };

  const [confirmRevokeOthers, setConfirmRevokeOthers] = useState(false);
  const [alsoRevokeKeys, setAlsoRevokeKeys] = useState(false);

  const userCount = new Set(sessions.map((s) => s.user)).size;

  // First whole-page fetch — auth config + workspace still loading.
  if (!loaded) return <AuthSettingsSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader title={t`Authentication`} description={<><Trans>Configure sign-in methods, MFA, and session policy. Tokens are signed with <span className="font-mono">$AUTH_SECRET</span>.</Trans></>} />
      <Tabs value={active} onValueChange={(v) => setTab(v as AuthTab)}>
        <TabsList>
          {[
            { id: "sign-in", label: t`Sign-in` },
            { id: "sso", label: t`SSO` },
            { id: "tokens", label: t`Tokens` },
            // "API", not "API & hooks": the longer label pushes the strip to
            // 397px against a 362px viewport at 390 wide, so the last tab
            // scrolls out of sight with nothing to say it is there. Both cards
            // inside name themselves anyway.
            { id: "api", label: t`API` },
            { id: "sessions", label: t`Sessions` },
          ].map((item) => (
            <TabsTrigger key={item.id} value={item.id}>{item.label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {active === "sign-in" && (<>
      <div className="grid grid-cols-[1fr_320px] items-start gap-4 max-[1280px]:grid-cols-1">
        <Card className="gap-0 py-0">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
            <span className="text-[13px] font-medium"><Trans>Providers</Trans></span>
            <div className="flex-1" />
            <Button size="sm" variant="outline" icon={I.Plus} onClick={() => setAdding(true)}><Trans>Add</Trans></Button>
          </div>
          {providers.length === 0 && <div className="border-b border-border px-4 py-3.5 text-[12.5px] text-muted-foreground"><Trans>Couldn't load auth config.</Trans></div>}
          {providers.map((p) => {
            const lockedOff = !p.configured && !p.enabled;
            return (
            <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0">
              <span><I.Shield size={13} /></span>
              <div className="min-w-0 shrink-0 grow basis-[160px]">
                <div className="truncate text-[13px] font-medium">{p.name}</div>
                {p.clientId && <div className="truncate font-mono text-[11px] text-muted-foreground">{p.clientId}</div>}
                {!p.clientId && p.discoveryUrl && <div className="truncate font-mono text-[11px] text-muted-foreground">{p.discoveryUrl}</div>}
                {p.system && <div className="text-[11px] text-muted-foreground"><Trans>built-in</Trans></div>}
                {p.enabled && !p.configured && <div className="text-[11px] text-destructive"><Trans>enabled but not configured — won't appear on sign-in</Trans></div>}
              </div>
              {!p.configured && <Badge variant={p.enabled ? "destructive" : "secondary"}><Trans>not configured</Trans></Badge>}
              <div className="flex items-center gap-3">
                <Button size="sm" variant="ghost" onClick={() => setConfiguring(p)}><Trans>Configure</Trans></Button>
                <Switch
                  checked={p.enabled}
                  disabled={lockedOff}
                  title={lockedOff ? t`Configure this provider (add a Client ID) before enabling it` : undefined}
                  onChange={(v) => requestToggleProvider(p.id, v)}
                />
              </div>
            </div>
            );
          })}
        </Card>
        <Card className="gap-3.5 p-[18px]">
          <span className="text-[13px] font-medium"><Trans>Policy</Trans></span>
          {POLICY_ROWS.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-3 border-t border-border pt-3">
              <div>
                <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{r.label}</div>
                <div className="text-[11.5px] text-muted-foreground">{r.desc}</div>
                {r.key === "openSignup" && workspace && workspace.slug !== "default" && (
                  <div className="mt-1 text-[11.5px] text-[oklch(0.62_0.13_75)]">
                    <Trans>This governs sign-up for <strong>{workspace.name}</strong>'s end-user apps. Admin-dashboard sign-up is controlled from the <strong>Default workspace</strong>'s Auth Settings.</Trans>
                  </div>
                )}
              </div>
              <Switch checked={policy[r.key] ?? r.fallback} onChange={(v) => setPolicyFlag(r.key, v)} />
            </div>
          ))}
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Session lifetime</Trans></label>
            <Select value={sessionLifetime} onChange={(v) => void saveSessionLifetime(v)} options={SESSION_LIFETIMES} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Allowed redirect URLs</Trans></label>
            <Textarea
              rows={3}
              value={redirectText}
              onChange={(e) => setRedirectText(e.target.value)}
              onBlur={() => void saveRedirects()}
              placeholder={"https://app.example.com/auth/callback\nhttp://localhost:5173/auth/callback"}
              className="font-mono h-auto text-xs"
            />
            <span className="text-[11.5px] text-muted-foreground"><Trans>One URL per line — saved when you click away.</Trans></span>
          </div>
        </Card>
      </div>
      {/* The gate in front of the sign-in endpoints — it is about who may
          REACH them, not about how they work, so it trails the pair above. */}
      <CaptchaCard pushToast={pushToast} />
      </>)}

      {active === "sso" && (ssoLoaded ? (<>
      <Card className="gap-0 py-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.Shield size={13} />
          <span className="text-[13px] font-medium"><Trans>SAML 2.0 SSO</Trans></span>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {samlProviders.length} {samlProviders.length === 1 ? t`provider` : t`providers`}
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            icon={I.Plus}
            onClick={() => setSamlDialog({ mode: "create" })}
          >
            <Trans>Add SAML</Trans>
          </Button>
        </div>
        {samlProviders.length === 0 && (
          <div className="border-b border-border px-4 py-3.5 text-[12.5px] text-muted-foreground">
            <Trans>No SAML providers configured. Add one to enable IdP-based SSO for this workspace's end-users.</Trans>
          </div>
        )}
        {samlProviders.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3.5 py-3 text-[13px] last:border-b-0 md:grid md:grid-cols-[24px_1fr_auto_auto_auto_auto] md:gap-3 md:py-[11px]"
          >
            <span className="shrink-0">
              <I.Shield size={13} />
            </span>
            <div className="min-w-0 flex-1">
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
                  <Trans>No signing cert stored — login will fail.</Trans>
                </div>
              )}
            </div>
            <Badge variant="default">SAML</Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSamlDialog({ mode: "edit", row: p })}
            >
              <Trans>Configure</Trans>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void removeSamlProvider(p.id)}
            >
              <Trans>Delete</Trans>
            </Button>
            <Switch
              checked={p.enabled}
              onChange={(v) => void toggleSamlEnabled(p, v)}
            />
          </div>
        ))}
      </Card>

      <Card className="gap-0 py-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.Key size={13} />
          <span className="text-[13px] font-medium"><Trans>OIDC / OAuth2 SSO</Trans></span>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {oidcProviders.length} {oidcProviders.length === 1 ? t`provider` : t`providers`}
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            icon={I.Plus}
            onClick={() => setOidcDialog({ mode: "create" })}
          >
            <Trans>Add OIDC</Trans>
          </Button>
        </div>
        {oidcProviders.length === 0 && (
          <div className="border-b border-border px-4 py-3.5 text-[12.5px] text-muted-foreground">
            <Trans>No OIDC providers configured. Add one to let this workspace's end-users sign in with Okta, Auth0, Keycloak, Entra ID and friends.</Trans>
          </div>
        )}
        {oidcProviders.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3.5 py-3 text-[13px] last:border-b-0 md:grid md:grid-cols-[24px_1fr_auto_auto_auto_auto] md:gap-3 md:py-[11px]"
          >
            <span className="shrink-0">
              <I.Key size={13} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{p.name}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {p.slug} · {p.discoveryUrl || p.authorizationUrl || "—"}
              </div>
              {!p.hasClientSecret && (
                <div className="text-[11px] text-destructive">
                  <Trans>No client secret stored — login will fail.</Trans>
                </div>
              )}
            </div>
            <Badge variant="default">OIDC</Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setOidcDialog({ mode: "edit", row: p })}
            >
              <Trans>Configure</Trans>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRemoveOidc({ id: p.id })}
            >
              <Trans>Delete</Trans>
            </Button>
            <Switch
              checked={p.enabled}
              onChange={(v) => void toggleOidcEnabled(p, v)}
            />
          </div>
        ))}
      </Card>

      <ScimCard availableRoles={availableRoles} pushToast={pushToast} />

      <LdapConfigCard availableRoles={availableRoles} pushToast={pushToast} />
      </>) : <AuthSsoTabSkeleton />)}

      {active === "tokens" && (<>
      {/* What signs the tokens the auth endpoints hand out. */}
      <SigningKeysCard pushToast={pushToast} />
      {/* Who those tokens are minted FOR. */}
      <OAuthClientsCard pushToast={pushToast} />
      {/* And whose tokens we accept without having minted them. */}
      <ThirdPartyAuthCard availableRoles={availableRoles} pushToast={pushToast} />
      </>)}

      {active === "api" && (<>
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
            <Button size="sm" variant="ghost" onClick={() => void copyText(value, () => pushToast?.(t`Copied.`))}><Trans>Copy</Trans></Button>
          </div>
        );
        const Snippet = ({ label, code }: { label: string; code: string }) => (
          <div className="flex flex-col gap-1.5">
            <div className="mb-1 flex items-center gap-2">
              <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{label}</span>
              <div className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => void copyText(code, () => pushToast?.(t`Copied.`))}><Trans>Copy</Trans></Button>
            </div>
            <ScrollArea className="rounded-surface"><pre className="m-0 whitespace-pre rounded-surface bg-muted p-3 font-mono text-[11.5px]">{code}</pre></ScrollArea>
          </div>
        );
        const sdkCode =
`import { createClient } from "backlex";

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
          <Card className="gap-3.5 p-[18px]">
            <div>
              <span className="text-[13px] font-medium"><Trans>Workspace auth API <span className="font-normal text-muted-foreground">· auth as a service</span></Trans></span>
              <div className="mt-[3px] text-xs text-muted-foreground"><Trans>End-users of the app built on this workspace sign in here — separate from the admin login. Configure providers above.</Trans></div>
            </div>
            <div>
              <Row label={t`Auth base URL`} value={authBase} />
              <Row label={t`Provider discovery`} value={`${authBase}/providers`} />
              <Row label={t`Sign-up / sign-in / get-session / sign-out`} value={`${authBase}/{sign-up|sign-in}/email · ${authBase}/get-session · ${authBase}/sign-out`} />
              {oauthIds.map((id) => (
                <Row key={id} label={t`OAuth redirect URI to register with ${AUTH_PROVIDER_NAMES[id] ?? id}`} value={`${authBase}/callback/${id}`} />
              ))}
            </div>
            <Snippet label={t`Frontend SDK`} code={sdkCode} />
            <Snippet label="curl" code={curlCode} />
          </Card>
        );
      })()}
      {/* Where an application steps INTO those endpoints. */}
      <AuthHooksCard pushToast={pushToast} />
      </>)}

      {active === "sessions" && (sessionsLoaded ? (
      <Card className="gap-0 py-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.Activity size={13} />
          <span className="text-[13px] font-medium"><Trans>Active sessions</Trans></span>
          <span className="font-mono text-[11.5px] text-muted-foreground">{sessions.length} {sessions.length === 1 ? t`session` : t`sessions`} · {userCount} {userCount === 1 ? t`user` : t`users`}</span>
          <div className="flex-1" />
          <Button size="sm" variant="outline" icon={I.LogOut} onClick={() => { setAlsoRevokeKeys(false); setConfirmRevokeOthers(true); }}><Trans>Revoke others</Trans></Button>
        </div>
        <Table className="[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground">
          <TableHeader><TableRow><TableHead><Trans>User</Trans></TableHead><TableHead><Trans>Device</Trans></TableHead><TableHead><Trans>Location</Trans></TableHead><TableHead>IP</TableHead><TableHead><Trans>Created</Trans></TableHead><TableHead><Trans>Last seen</Trans></TableHead><TableHead className="sticky right-0 w-11 border-l border-border bg-card shadow-[-8px_0_12px_-8px_oklch(0_0_0/0.18)]" /></TableRow></TableHeader>
          <TableBody>
            {sessions.length === 0 && <TableRow><TableCell colSpan={7} className="text-muted-foreground"><Trans>No active sessions.</Trans></TableCell></TableRow>}
            {(showAllSessions ? sessions : sessions.slice(0, SESSIONS_PAGE)).map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.user}{s.current && <Badge variant="default" className="ml-1.5"><Trans>current</Trans></Badge>}</TableCell>
                <TableCell className="font-mono text-[11.5px]">{s.device}</TableCell>
                <TableCell>{s.loc}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{s.ip}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{s.created}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{s.last}</TableCell>
                <TableCell className="sticky right-0 border-l border-border bg-card text-right shadow-[-8px_0_12px_-8px_oklch(0_0_0/0.18)]">{!s.current && <IconButton icon={I.LogOut} onClick={() => void revokeSession(s.id)} title={t`Revoke`} className="text-muted-foreground hover:text-destructive" />}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {sessions.length > SESSIONS_PAGE && (
          <div className="flex justify-center border-t border-border px-4 py-2.5">
            <Button size="sm" variant="ghost" onClick={() => setShowAllSessions((v) => !v)}>
              {showAllSessions
                ? <Trans>Show fewer</Trans>
                : <Trans>Show all {sessions.length} sessions</Trans>}
            </Button>
          </div>
        )}
      </Card>
      ) : <AuthSessionsTabSkeleton />)}

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
      {oidcDialog && (
        <OidcProviderDialog
          existing={oidcDialog.mode === "edit" ? oidcDialog.row : null}
          workspaceSlug={workspace?.slug ?? ""}
          pushToast={pushToast}
          onClose={() => setOidcDialog(null)}
          onSave={(body, existing) => void saveOidcProvider(body, existing)}
        />
      )}
      <ConfirmDialog
        open={confirmRevokeOthers}
        title={t`Sign out other devices?`}
        description={
          <span className="flex flex-col gap-2.5">
            <span>
              <Trans>
                Every other session for your account is signed out. This one stays.
              </Trans>
            </span>
            {/* The gap, stated where the decision is made. API keys are keyed on
                the user and never on a session, so a sign-out has never touched
                one — and a stolen session is long-lived enough to mint a key
                that outlives it. Off by default because the same key routinely
                powers a CI job or a server integration that has nothing to do
                with the device being signed out. */}
            <label className="flex cursor-pointer items-start gap-2 text-[13px] leading-snug">
              <Checkbox
                className="mt-0.5 shrink-0"
                checked={alsoRevokeKeys}
                onCheckedChange={(v) => setAlsoRevokeKeys(v === true)}
              />
              <span>
                <Trans>Also revoke my API keys</Trans>
                <span className="block text-muted-foreground">
                  <Trans>
                    API keys are not sessions and survive a sign-out. Revoking them
                    breaks anything using them — CI jobs, server integrations.
                  </Trans>
                </span>
              </span>
            </label>
          </span>
        }
        actionLabel={alsoRevokeKeys ? t`Revoke sessions and keys` : t`Revoke sessions`}
        destructive={alsoRevokeKeys}
        onConfirm={async () => {
          setConfirmRevokeOthers(false);
          await revokeOthers(alsoRevokeKeys);
        }}
        onCancel={() => setConfirmRevokeOthers(false)}
      />
      <ConfirmDialog
        open={!!confirmRemoveOidc}
        title={t`Delete OIDC provider?`}
        description={t`End-users who signed in through it keep their accounts, but lose this sign-in route.`}
        actionLabel={t`Delete`}
        destructive
        onConfirm={async () => {
          if (confirmRemoveOidc) await doRemoveOidcProvider(confirmRemoveOidc.id);
          setConfirmRemoveOidc(null);
        }}
        onCancel={() => setConfirmRemoveOidc(null)}
      />
      <ConfirmDialog
        open={!!confirmRemoveSaml}
        title={t`Delete SAML provider?`}
        description={t`External identity rows are kept as an audit trail.`}
        actionLabel={t`Delete`}
        destructive
        onConfirm={async () => {
          if (confirmRemoveSaml) await doRemoveSamlProvider(confirmRemoveSaml.id);
          setConfirmRemoveSaml(null);
        }}
        onCancel={() => setConfirmRemoveSaml(null)}
      />
      <ConfirmDialog
        open={!!confirmBypass}
        title={t`This weakens two-factor authentication`}
        description={t`${AUTH_PROVIDER_NAMES[confirmBypass?.id ?? ""] ?? confirmBypass?.id ?? "This method"} signs users in without asking for their authenticator code — it bypasses TOTP two-factor for anyone who has it enabled. Their account is then only as secure as their email inbox. Enable it anyway?`}
        actionLabel={t`Enable anyway`}
        onConfirm={() => {
          if (confirmBypass) void toggleProvider(confirmBypass.id, true);
          setConfirmBypass(null);
        }}
        onCancel={() => setConfirmBypass(null)}
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
  const { t } = useLingui();
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
      <DialogContent className="gap-0 p-0 sm:max-w-[480px]">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>Configure {provider.name}</Trans></DialogTitle>
          <DialogDescription className="text-[12.5px]">
            {kind === "oauth" ? <Trans>OAuth 2.0 / OIDC sign-in provider.</Trans> : kind === "custom" ? <Trans>Custom OpenID Connect provider.</Trans> : <Trans>Built-in sign-in method.</Trans>}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
        <div className="flex flex-col gap-4 px-5 py-[18px]">
          {(() => {
            const blocked = (kind === "oauth" || kind === "custom") && !(clientId.trim() && hasSecret);
            return (
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Enabled</Trans></div>
                  <div className="text-[11.5px] text-muted-foreground">{blocked ? <Trans>Add a Client ID and secret below first.</Trans> : <Trans>Show this option on the sign-in screen.</Trans>}</div>
                </div>
                <Switch checked={enabled && !blocked} disabled={blocked} title={blocked ? t`Add a Client ID and secret first` : undefined} onChange={setEnabled} />
              </div>
            );
          })()}
          {kind === "custom" && (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Display name</Trans></label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t`Acme SSO`} />
            </div>
          )}
          {(kind === "oauth" || kind === "custom") && (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Client ID</Trans></label>
              <Input className="font-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123456789-abc.apps.example.com" />
            </div>
          )}
          {(kind === "oauth" || kind === "custom") && (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Client secret {provider.hasSecret && <span className="text-muted-foreground">· stored, leave blank to keep</span>}</Trans></label>
              <Input type="password" className="font-mono" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={provider.hasSecret ? "••••••••••••••••" : t`paste from the provider`} autoComplete="new-password" />
            </div>
          )}
          {kind === "custom" && (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Discovery URL <span className="text-muted-foreground">(optional)</span></Trans></label>
              <Input className="font-mono" value={discoveryUrl} onChange={(e) => setDiscoveryUrl(e.target.value)} placeholder="https://issuer.example.com/.well-known/openid-configuration" />
              {discoveryBad && <span className="text-[11.5px] text-destructive"><Trans>Must be a full http(s) URL.</Trans></span>}
            </div>
          )}
          {(kind === "oauth" || kind === "custom") && (
            <div className="text-[11.5px] leading-[1.5] text-muted-foreground">
              <Trans>The client secret is encrypted at rest. If you leave both fields blank, sign-in falls back to the{" "}
              <span className="font-mono">OAUTH_{provider.id.toUpperCase()}_CLIENT_ID</span> /{" "}
              <span className="font-mono">_CLIENT_SECRET</span> environment variables. Register{" "}
              <span className="font-mono">{appUrlPlaceholder}/api/t/{workspacePlaceholder}/auth/callback/{provider.id}</span> as the redirect URI with the provider.</Trans>
            </div>
          )}
          {kind === "builtin" && (
            <div className="text-[11.5px] leading-[1.5] text-muted-foreground">
              {provider.id === "email"
                ? <Trans>Email + password is always available — toggle it off to hide the form from the sign-in screen.</Trans>
                : provider.id === "passkey"
                  ? <Trans>Users enrol a passkey after signing in once with another method.</Trans>
                  : <Trans>Sends a one-time sign-in link by email — requires a configured email adapter (set RESEND_API_KEY + EMAIL_FROM).</Trans>}
            </div>
          )}
        </div>
        </DialogBody>
        <DialogFooter className="border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button variant="primary" size="sm" icon={I.Check} disabled={!valid} onClick={submit}><Trans>Save</Trans></Button>
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
  const { t } = useLingui();
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
      <DialogContent className="gap-0 p-0 sm:max-w-[480px]">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>Add OIDC provider</Trans></DialogTitle>
          <DialogDescription className="text-[12.5px]"><Trans>Register a custom OpenID Connect identity provider.</Trans></DialogDescription>
        </DialogHeader>
        <DialogBody>
        <div className="flex flex-col gap-4 px-5 py-[18px]">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Display name</Trans></label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t`Acme SSO`} />
            <span className="font-mono text-[11px] text-muted-foreground">
              id: <span className={idTaken ? "text-destructive" : "text-foreground"}>{slug || "—"}</span>
              {idTaken && <span className="text-destructive"> · <Trans>already exists</Trans></span>}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Client ID <span className="text-muted-foreground">(optional)</span></Trans></label>
            <Input className="font-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="abc123" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Discovery URL <span className="text-muted-foreground">(optional)</span></Trans></label>
            <Input className="font-mono" value={discoveryUrl} onChange={(e) => setDiscoveryUrl(e.target.value)} placeholder="https://issuer.example.com/.well-known/openid-configuration" />
            {discoveryBad && <span className="text-[11.5px] text-destructive"><Trans>Must be a full http(s) URL.</Trans></span>}
          </div>
          <div className="text-[11.5px] leading-[1.5] text-muted-foreground">
            <Trans>The provider is added disabled. Set its client secret server-side, then enable it here.</Trans>
          </div>
        </div>
        </DialogBody>
        <DialogFooter className="items-center border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3 sm:justify-start">
          <span className="text-xs text-muted-foreground">{valid ? <Trans>Will be added disabled.</Trans> : idTaken ? <Trans>Pick a unique name.</Trans> : <Trans>Enter a name to continue.</Trans>}</span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button variant="primary" size="sm" icon={I.Plus} disabled={!valid} onClick={submit}><Trans>Add provider</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
