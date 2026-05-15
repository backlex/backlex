// @ts-nocheck
// Personal account settings. Reached only via the header avatar dropdown
// (not in the sidebar); every signed-in user — admin or not — can open it
// and manage their own profile, password, sessions, and connected
// credentials. Everything talks to better-auth's self-service endpoints
// at /api/auth/* so there's no extra server route involved.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Checkbox } from "@workeros/ui/components/checkbox";
import { auth } from "@/lib/auth";
import { api } from "@/lib/api";
import { I } from "./icons";
import { Badge, Button, PageHeader } from "./ui";

interface SessionRow {
  id: string;
  token: string;
  device: string;
  ip: string;
  created: string;
  last: string;
  current: boolean;
}

interface LinkedAccount {
  id: string;
  providerId: string;
}

interface PasskeyRow {
  id: string;
  name: string | null;
  createdAt: string | number | null;
}

interface ProvidersResp {
  providers: { id: string; name?: string; enabled?: boolean }[];
}

const fmtRelative = (iso: string | number | null | undefined): string => {
  if (iso == null) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const ms = Date.now() - t;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
};

const fmtCreated = (iso: string | number | null | undefined): string => {
  if (iso == null) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toISOString().replace("T", " ").slice(0, 19);
};

const errMsg = (e: unknown): string => {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  try { return JSON.stringify(e); } catch { return "Unknown error"; }
};

/** better-auth client methods return `{ data, error }`. Throw on error so
 *  call sites can use plain try/catch instead of branching on the shape. */
const unwrap = <T,>(res: { data?: T | null; error?: { message?: string } | null }): T => {
  if (res && res.error) throw new Error(res.error.message ?? "Request failed");
  return (res?.data ?? null) as T;
};

export function AccountPage({ pushToast }: { pushToast: (m: string) => void }) {
  const session = auth.useSession();
  const sessionUser = (session.data as { user?: { id?: string; name?: string | null; email?: string; image?: string | null } } | null)?.user ?? null;
  const currentSessionToken =
    (session.data as { session?: { token?: string } } | null)?.session?.token ?? null;

  const [tab, setTab] = useState<"profile" | "security" | "sessions" | "connected">("profile");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Account"
        description="Your personal profile, password, sessions, and connected credentials. Workspace-wide settings live under the Settings page."
      />
      <div className="tabs">
        {[
          { id: "profile" as const, label: "Profile" },
          { id: "security" as const, label: "Security" },
          { id: "sessions" as const, label: "Sessions" },
          { id: "connected" as const, label: "Connected" },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            className="tab"
            data-active={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {tab === "profile" && (
        <ProfileCard user={sessionUser} pushToast={pushToast} refetch={() => session.refetch()} />
      )}
      {tab === "security" && (
        <SecurityCard pushToast={pushToast} />
      )}
      {tab === "sessions" && (
        <SessionsCard currentToken={currentSessionToken} pushToast={pushToast} />
      )}
      {tab === "connected" && (
        <ConnectedCard pushToast={pushToast} />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Profile
// --------------------------------------------------------------------------

function ProfileCard({
  user,
  pushToast,
  refetch,
}: {
  user: { id?: string; name?: string | null; email?: string; image?: string | null } | null;
  pushToast: (m: string) => void;
  refetch: () => void;
}) {
  const [name, setName] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [imageBust, setImageBust] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Hydrate when the session user is known.
  useEffect(() => {
    if (!user) return;
    setName(user.name ?? "");
    setImage(user.image ?? null);
    setImageBust(String(Date.now()));
    setDirty(false);
  }, [user?.id, user?.name, user?.image]);

  // `auth.updateUser({image})` accepts a string. We keep the storage logical
  // key (e.g. "account-avatars/<uid>.png") in `user.image` and render it
  // through `/api/storage/<key>` so the same-origin cookie auth applies.
  const previewSrc = useMemo(() => {
    if (!image) return null;
    if (/^https?:\/\//i.test(image) || image.startsWith("/")) return image;
    return `/api/storage/${encodeURIComponent(image)}${imageBust ? `?v=${imageBust}` : ""}`;
  }, [image, imageBust]);

  const upload = async (file: File) => {
    if (!user?.id) {
      pushToast("Not signed in.");
      return;
    }
    const ext = (file.name.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    const key = `account-avatars/${user.id}.${ext}`;
    setUploading(true);
    try {
      const res = await fetch(`/api/storage/${encodeURIComponent(key)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Upload failed (${res.status}): ${txt.slice(0, 200)}`);
      }
      setImage(key);
      setImageBust(String(Date.now()));
      setDirty(true);
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      unwrap(await auth.updateUser({ name: name.trim(), image }));
      setDirty(false);
      pushToast("Profile saved.");
      refetch();
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 16, maxWidth: 720 }}>
      <div className="field-row">
        <div>
          <div className="field-label">Avatar</div>
          <div className="field-hint">PNG, JPG or WebP. Shown in the header and on any author display.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            aria-hidden
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: previewSrc ? `center/cover no-repeat url('${previewSrc}')` : "var(--muted)",
              border: "1px solid var(--border)",
              display: "grid",
              placeItems: "center",
              fontSize: 18,
              fontWeight: 600,
              color: "var(--muted-foreground)",
            }}
          >
            {!previewSrc && ((user?.name ?? user?.email ?? "?").slice(0, 1).toUpperCase())}
          </span>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={uploading || !user?.id}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? "Uploading…" : image ? "Replace" : "Upload"}
          </Button>
          {image && (
            <Button
              variant="ghost"
              size="sm"
              disabled={uploading}
              onClick={() => { setImage(null); setDirty(true); }}
            >
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="field" style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
        <label className="field-label">Name</label>
        <input
          className="input"
          value={name}
          onChange={(e) => { setName(e.target.value); setDirty(true); }}
          placeholder="Your display name"
        />
        <span className="field-hint">Shown in author bylines and the header dropdown.</span>
      </div>
      <div className="field-row">
        <div>
          <div className="field-label">Email</div>
          <div className="field-hint">Email changes aren't supported yet — contact an admin if you need to switch addresses.</div>
        </div>
        <span className="font-mono muted" style={{ fontSize: 12.5 }}>{user?.email ?? "—"}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 6 }}>
        <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => {
          setName(user?.name ?? "");
          setImage(user?.image ?? null);
          setDirty(false);
        }}>Discard</Button>
        <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Security
// --------------------------------------------------------------------------

function SecurityCard({ pushToast }: { pushToast: (m: string) => void }) {
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [revokeOthers, setRevokeOthers] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);

  // A user has a password when one of their linked accounts is the
  // built-in "credential" provider. Social-only users get a "set password"
  // form (no old password required).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = unwrap<LinkedAccount[]>(await auth.listUserAccounts());
        if (cancelled) return;
        setHasPassword(Array.isArray(list) && list.some((a) => a.providerId === "credential"));
      } catch {
        // Treat unknown as "has password" so we don't accidentally hide the
        // change-password form for users who do.
        if (!cancelled) setHasPassword(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const submitChange = async () => {
    if (newPw.length < 8) { pushToast("New password must be at least 8 characters."); return; }
    if (newPw !== confirmPw) { pushToast("New password and confirmation don't match."); return; }
    setSaving(true);
    try {
      if (hasPassword) {
        unwrap(await auth.changePassword({ currentPassword: oldPw, newPassword: newPw, revokeOtherSessions: revokeOthers }));
        pushToast(revokeOthers ? "Password changed; other sessions signed out." : "Password changed.");
      } else {
        unwrap(await auth.setPassword({ newPassword: newPw }));
        setHasPassword(true);
        pushToast("Password set.");
      }
      setOldPw(""); setNewPw(""); setConfirmPw(""); setRevokeOthers(false);
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const signOutOthers = async () => {
    setRevoking(true);
    try {
      unwrap(await auth.revokeOtherSessions());
      pushToast("All other devices signed out.");
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }}>
      <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.Lock size={14} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>{hasPassword === false ? "Set a password" : "Change password"}</span>
        </div>
        {hasPassword === false && (
          <div className="field-hint">You signed in with a social provider. Setting a password lets you also sign in with email + password.</div>
        )}
        {hasPassword !== false && (
          <div className="field">
            <label className="field-label">Current password</label>
            <input className="input" type="password" autoComplete="current-password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label className="field-label">New password</label>
          <input className="input" type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          <span className="field-hint">At least 8 characters.</span>
        </div>
        <div className="field">
          <label className="field-label">Confirm new password</label>
          <input className="input" type="password" autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
        </div>
        {hasPassword !== false && (
          <label htmlFor="revoke-others" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
            <Checkbox
              id="revoke-others"
              checked={revokeOthers}
              onCheckedChange={(v) => setRevokeOthers(v === true)}
            />
            Sign out from all other devices
          </label>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button
            variant="primary"
            size="sm"
            disabled={saving || !newPw || !confirmPw || (hasPassword !== false && !oldPw)}
            onClick={submitChange}
          >
            {saving ? "Saving…" : (hasPassword === false ? "Set password" : "Update password")}
          </Button>
        </div>
      </div>

      <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.LogOut size={14} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Sign out elsewhere</span>
        </div>
        <div className="field-hint">Revokes every active session except the one you're on right now.</div>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="outline" size="sm" disabled={revoking} onClick={signOutOthers}>
            {revoking ? "Revoking…" : "Sign out other devices"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Sessions
// --------------------------------------------------------------------------

function SessionsCard({
  currentToken,
  pushToast,
}: {
  currentToken: string | null;
  pushToast: (m: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = unwrap<any[]>(await auth.listSessions());
      const rows = (Array.isArray(list) ? list : []).map((s): SessionRow => ({
        id: s.id,
        token: s.token,
        device: (s.userAgent ?? "unknown agent").slice(0, 64),
        ip: s.ipAddress ?? "—",
        created: fmtCreated(s.createdAt),
        last: fmtRelative(s.updatedAt ?? s.createdAt),
        current: !!currentToken && s.token === currentToken,
      }));
      // Current session first.
      rows.sort((a, b) => (a.current === b.current ? 0 : a.current ? -1 : 1));
      setSessions(rows);
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [currentToken, pushToast]);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (token: string, label: string) => {
    try {
      unwrap(await auth.revokeSession({ token }));
      setSessions((arr) => arr.filter((s) => s.token !== token));
      pushToast(`Session ${label} revoked.`);
    } catch (e) {
      pushToast(errMsg(e));
    }
  };

  return (
    <div className="card">
      <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <I.Activity size={13} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>Active sessions</span>
        <span className="muted font-mono" style={{ fontSize: 11.5 }}>{sessions.length} session{sessions.length === 1 ? "" : "s"}</span>
        <div className="spacer" />
        <Button size="sm" variant="ghost" onClick={() => void load()}>{loading ? "Refreshing…" : "Refresh"}</Button>
      </div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr><th>Device</th><th>IP</th><th>Created</th><th>Last seen</th><th></th></tr>
          </thead>
          <tbody>
            {!loading && sessions.length === 0 && (
              <tr><td colSpan={5} className="muted" style={{ padding: 14 }}>No active sessions.</td></tr>
            )}
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{s.device}{s.current && <Badge variant="default" style={{ marginLeft: 6 }}>current</Badge>}</td>
                <td className="font-mono muted" style={{ fontSize: 11.5 }}>{s.ip}</td>
                <td className="muted font-mono" style={{ fontSize: 11.5 }}>{s.created}</td>
                <td className="muted font-mono" style={{ fontSize: 11.5 }}>{s.last}</td>
                <td style={{ textAlign: "right" }}>
                  {!s.current && <Button size="sm" variant="ghost" onClick={() => void revoke(s.token, s.id.slice(0, 6) + "…")}>Revoke</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Connected (social accounts + passkeys)
// --------------------------------------------------------------------------

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  apple: "Apple",
  discord: "Discord",
  facebook: "Facebook",
  twitter: "Twitter / X",
  spotify: "Spotify",
  twitch: "Twitch",
  linkedin: "LinkedIn",
  gitlab: "GitLab",
  reddit: "Reddit",
  dropbox: "Dropbox",
  kick: "Kick",
};

function ConnectedCard({ pushToast }: { pushToast: (m: string) => void }) {
  const [providers, setProviders] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [linking, setLinking] = useState<string | null>(null);

  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [loadingPk, setLoadingPk] = useState(true);
  const [newPkName, setNewPkName] = useState("");
  const [addingPk, setAddingPk] = useState(false);

  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    try {
      const list = unwrap<any[]>(await auth.listUserAccounts());
      const rows = (Array.isArray(list) ? list : []).map((a): LinkedAccount => ({
        id: String(a.id),
        providerId: String(a.providerId),
      }));
      setAccounts(rows);
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setLoadingAccounts(false);
    }
  }, [pushToast]);

  const loadProviders = useCallback(async () => {
    try {
      const r = await api<ProvidersResp>("/api/auth/providers");
      const ids = (r.providers ?? [])
        .filter((p) => p.enabled !== false)
        .map((p) => p.id)
        .filter((id) => id !== "credential" && id !== "magic-link" && id !== "email-otp" && id !== "passkey");
      setProviders(ids);
    } catch {
      setProviders([]);
    }
  }, []);

  const loadPasskeys = useCallback(async () => {
    setLoadingPk(true);
    try {
      const r = await api<{ passkeys?: PasskeyRow[] } | PasskeyRow[]>(
        "/api/auth/passkey/list-user-passkeys",
        { method: "GET" },
      );
      const arr = Array.isArray(r) ? r : ((r as { passkeys?: PasskeyRow[] }).passkeys ?? []);
      setPasskeys(arr.map((p) => ({
        id: String(p.id),
        name: p.name ?? null,
        createdAt: p.createdAt ?? null,
      })));
    } catch (e) {
      // Plugin may not be wired — quietly empty list, only toast if it's a real error.
      const msg = errMsg(e);
      if (!/404/.test(msg)) pushToast(msg);
      setPasskeys([]);
    } finally {
      setLoadingPk(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void loadAccounts();
    void loadProviders();
    void loadPasskeys();
  }, [loadAccounts, loadProviders, loadPasskeys]);

  const link = async (provider: string) => {
    setLinking(provider);
    try {
      // better-auth's linkSocial returns a `{ data: { url } }` for the OAuth
      // redirect. Navigate to the URL so the provider can sign the user in.
      const res = await auth.linkSocial({
        provider,
        callbackURL: window.location.pathname,
      });
      const url = (res as { data?: { url?: string } }).data?.url;
      if (url) {
        window.location.href = url;
        return;
      }
      // Some flows complete in-place; fall through to reload list.
      await loadAccounts();
      pushToast(`Linked ${PROVIDER_LABELS[provider] ?? provider}.`);
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setLinking(null);
    }
  };

  const unlink = async (account: LinkedAccount) => {
    if (accounts.length <= 1) {
      pushToast("Can't unlink your only sign-in method.");
      return;
    }
    try {
      unwrap(await auth.unlinkAccount({ accountId: account.id, providerId: account.providerId }));
      setAccounts((arr) => arr.filter((a) => a.id !== account.id));
      pushToast(`Unlinked ${PROVIDER_LABELS[account.providerId] ?? account.providerId}.`);
    } catch (e) {
      pushToast(errMsg(e));
    }
  };

  const addPasskey = async () => {
    setAddingPk(true);
    try {
      const name = newPkName.trim();
      const res = await (auth as unknown as { passkey: { addPasskey: (i: { name?: string }) => Promise<{ error?: { message?: string } | null }> } })
        .passkey.addPasskey(name ? { name } : {});
      if (res && (res as { error?: { message?: string } | null }).error) {
        throw new Error((res as { error: { message?: string } }).error.message ?? "Passkey registration failed");
      }
      setNewPkName("");
      await loadPasskeys();
      pushToast("Passkey added.");
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setAddingPk(false);
    }
  };

  const removePasskey = async (id: string) => {
    try {
      await api<{ ok?: boolean } | unknown>("/api/auth/passkey/delete-passkey", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      setPasskeys((arr) => arr.filter((p) => p.id !== id));
      pushToast("Passkey removed.");
    } catch (e) {
      pushToast(errMsg(e));
    }
  };

  const accountByProvider = new Map<string, LinkedAccount>();
  for (const a of accounts) accountByProvider.set(a.providerId, a);
  const knownProviders = new Set(providers);
  // Show linked accounts even if the provider isn't currently enabled, so a
  // user can still unlink them.
  for (const a of accounts) {
    if (a.providerId !== "credential") knownProviders.add(a.providerId);
  }
  const displayProviders = Array.from(knownProviders);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 720 }}>
      <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.Globe size={14} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Social sign-in</span>
        </div>
        {displayProviders.length === 0 && (
          <div className="muted" style={{ fontSize: 12.5 }}>
            {loadingAccounts ? "Loading…" : "No social providers are enabled for this workspace."}
          </div>
        )}
        {displayProviders.map((id) => {
          const linked = accountByProvider.get(id);
          return (
            <div key={id} className="field-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <div>
                <div className="field-label">{PROVIDER_LABELS[id] ?? id}</div>
                <div className="field-hint">{linked ? "Linked — you can sign in with this provider." : "Not linked."}</div>
              </div>
              {linked ? (
                <Button size="sm" variant="ghost" onClick={() => void unlink(linked)}>Unlink</Button>
              ) : (
                <Button size="sm" variant="outline" disabled={linking === id} onClick={() => void link(id)}>
                  {linking === id ? "Redirecting…" : "Link"}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.Shield size={14} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Passkeys</span>
          <span className="muted font-mono" style={{ fontSize: 11.5 }}>{passkeys.length}</span>
        </div>
        <div className="field-hint">Sign in with Touch ID, Face ID, a Windows Hello PIN, or a hardware security key.</div>
        <div className="field-row">
          <input
            className="input"
            value={newPkName}
            onChange={(e) => setNewPkName(e.target.value)}
            placeholder="Name this passkey (e.g. MacBook Touch ID)"
            style={{ flex: 1 }}
          />
          <Button size="sm" variant="primary" disabled={addingPk} onClick={addPasskey}>
            {addingPk ? "Waiting for browser…" : "Add passkey"}
          </Button>
        </div>
        {!loadingPk && passkeys.length === 0 && (
          <div className="muted" style={{ fontSize: 12.5 }}>You haven't registered any passkeys yet.</div>
        )}
        {passkeys.map((p) => (
          <div key={p.id} className="field-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <div>
              <div className="field-label">{p.name || "Unnamed passkey"}</div>
              <div className="field-hint">Added {fmtRelative(p.createdAt)}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void removePasskey(p.id)}>Remove</Button>
          </div>
        ))}
      </div>
    </div>
  );
}
