// Personal account settings. Reached only via the header avatar dropdown
// (not in the sidebar); every signed-in user — admin or not — can open it
// and manage their own profile, password, sessions, and connected
// credentials. Everything talks to better-auth's self-service endpoints
// at /api/auth/* so there's no extra server route involved.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIcon,
  GlobeIcon,
  LockIcon,
  LogOutIcon,
  ShieldIcon,
} from "lucide-react";
import { Button } from "@workeros/ui/components/button";
import { Badge } from "@workeros/ui/components/badge";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Checkbox } from "@workeros/ui/components/checkbox";
import { Avatar, AvatarFallback, AvatarImage } from "@workeros/ui/components/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workeros/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";
import { Separator } from "@workeros/ui/components/separator";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { PageHeader } from "@/components/page-header";
import { auth } from "@/lib/auth";
import { api } from "@/lib/api";
import { accountApi } from "./api";
import { Select } from "./select";
import {
  localeLabel,
  makeFormatters,
  timezoneOptions,
  usePreferences,
} from "./preferences";

interface SessionRow {
  id: string;
  token: string;
  device: string;
  ip: string;
  /** Raw timestamps — formatted at render time in the user's time zone. */
  createdAt: string | number | null;
  lastAt: string | number | null;
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

type AccountTab =
  | "profile"
  | "preferences"
  | "security"
  | "sessions"
  | "connected";

export function AccountPage({ pushToast }: { pushToast: (m: string) => void }) {
  const session = auth.useSession();
  const sessionUser =
    (session.data as { user?: { id?: string; name?: string | null; email?: string; image?: string | null } } | null)
      ?.user ?? null;
  const currentSessionToken =
    (session.data as { session?: { token?: string } } | null)?.session?.token ?? null;

  const [tab, setTab] = useState<AccountTab>("profile");

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Account"
        description="Your personal profile, preferences, password, sessions, and connected credentials. Workspace-wide settings live under the Settings page."
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as AccountTab)}>
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="connected">Connected</TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <ProfileCard user={sessionUser} pushToast={pushToast} refetch={() => session.refetch()} />
        </TabsContent>
        <TabsContent value="preferences">
          <PreferencesCard pushToast={pushToast} />
        </TabsContent>
        <TabsContent value="security">
          <SecurityCard pushToast={pushToast} />
        </TabsContent>
        <TabsContent value="sessions">
          <SessionsCard currentToken={currentSessionToken} pushToast={pushToast} />
        </TabsContent>
        <TabsContent value="connected">
          <ConnectedCard pushToast={pushToast} />
        </TabsContent>
      </Tabs>
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

  const initial = (user?.name ?? user?.email ?? "?").slice(0, 1).toUpperCase();

  return (
    <Card className="max-w-3xl">
      <CardContent className="flex flex-col gap-6 pt-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Label>Avatar</Label>
            <p className="text-sm text-muted-foreground">
              PNG, JPG or WebP. Shown in the header and on any author display.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Avatar className="size-14">
              {previewSrc && <AvatarImage src={previewSrc} alt="Avatar preview" />}
              <AvatarFallback>{initial}</AvatarFallback>
            </Avatar>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
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
                onClick={() => {
                  setImage(null);
                  setDirty(true);
                }}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
        <Separator />
        <div className="flex flex-col gap-2">
          <Label htmlFor="account-name">Name</Label>
          <Input
            id="account-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            placeholder="Your display name"
          />
          <p className="text-sm text-muted-foreground">Shown in author bylines and the header dropdown.</p>
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Label>Email</Label>
            <p className="text-sm text-muted-foreground">
              Email changes aren't supported yet — contact an admin if you need to switch addresses.
            </p>
          </div>
          <span className="font-mono text-sm text-muted-foreground">{user?.email ?? "—"}</span>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => {
              setName(user?.name ?? "");
              setImage(user?.image ?? null);
              setDirty(false);
            }}
          >
            Discard
          </Button>
          {/* Fixed min width so the label swap (Save ⇄ Saving…) doesn't
              resize the button and shove the Discard button sideways. */}
          <Button
            size="sm"
            className="min-w-[5.5rem]"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
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
        const list = unwrap<LinkedAccount[]>(await auth.listAccounts());
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
        // `setPassword` is a sensitive-session-gated server endpoint that the
        // typed client doesn't expose; reach it through the raw API path. The
        // session cookie is sufficient on same-origin since the endpoint
        // requires a fresh session.
        const res = await fetch("/api/auth/set-password", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newPassword: newPw }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(body || `set-password failed (${res.status})`);
        }
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
    <div className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LockIcon className="size-4" />
            {hasPassword === false ? "Set a password" : "Change password"}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {hasPassword === false && (
            <p className="text-sm text-muted-foreground">
              You signed in with a social provider. Setting a password lets you also sign in with email + password.
            </p>
          )}
          {hasPassword !== false && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="old-pw">Current password</Label>
              <Input
                id="old-pw"
                type="password"
                autoComplete="current-password"
                value={oldPw}
                onChange={(e) => setOldPw(e.target.value)}
              />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-pw">New password</Label>
            <Input
              id="new-pw"
              type="password"
              autoComplete="new-password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
            />
            <p className="text-sm text-muted-foreground">At least 8 characters.</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-pw">Confirm new password</Label>
            <Input
              id="confirm-pw"
              type="password"
              autoComplete="new-password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
            />
          </div>
          {hasPassword !== false && (
            <label htmlFor="revoke-others" className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                id="revoke-others"
                checked={revokeOthers}
                onCheckedChange={(v) => setRevokeOthers(v === true)}
              />
              Sign out from all other devices
            </label>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={saving || !newPw || !confirmPw || (hasPassword !== false && !oldPw)}
              onClick={submitChange}
            >
              {saving ? "Saving…" : hasPassword === false ? "Set password" : "Update password"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LogOutIcon className="size-4" />
            Sign out elsewhere
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Revokes every active session except the one you're on right now.
          </p>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" disabled={revoking} onClick={signOutOthers}>
              {revoking ? "Revoking…" : "Sign out other devices"}
            </Button>
          </div>
        </CardContent>
      </Card>
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
  const { formatDateTime, formatRelative } = usePreferences();
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
        createdAt: s.createdAt ?? null,
        lastAt: s.updatedAt ?? s.createdAt ?? null,
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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ActivityIcon className="size-4" />
          Active sessions
          <span className="font-mono text-xs text-muted-foreground">
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </span>
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Device</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loading && sessions.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No active sessions.
                </TableCell>
              </TableRow>
            )}
            {sessions.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  {s.device}
                  {s.current && <Badge className="ml-2">current</Badge>}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{s.ip}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{formatDateTime(s.createdAt)}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{formatRelative(s.lastAt)}</TableCell>
                <TableCell className="text-right">
                  {!s.current && (
                    <Button size="sm" variant="ghost" onClick={() => void revoke(s.token, s.id.slice(0, 6) + "…")}>
                      Revoke
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
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
  const { formatRelative } = usePreferences();
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
      const list = unwrap<any[]>(await auth.listAccounts());
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
    <div className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GlobeIcon className="size-4" />
            Social sign-in
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {displayProviders.length === 0 && (
            loadingAccounts ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No social providers are enabled for this workspace.
              </p>
            )
          )}
          {displayProviders.map((id, idx) => {
            const linked = accountByProvider.get(id);
            return (
              <div key={id} className={idx > 0 ? "border-t pt-3" : undefined}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label>{PROVIDER_LABELS[id] ?? id}</Label>
                    <p className="text-sm text-muted-foreground">
                      {linked ? "Linked — you can sign in with this provider." : "Not linked."}
                    </p>
                  </div>
                  {linked ? (
                    <Button size="sm" variant="ghost" onClick={() => void unlink(linked)}>
                      Unlink
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={linking === id}
                      onClick={() => void link(id)}
                    >
                      {linking === id ? "Redirecting…" : "Link"}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldIcon className="size-4" />
            Passkeys
            <span className="font-mono text-xs text-muted-foreground">{passkeys.length}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Sign in with Touch ID, Face ID, a Windows Hello PIN, or a hardware security key.
          </p>
          <div className="flex items-center gap-2">
            <Input
              value={newPkName}
              onChange={(e) => setNewPkName(e.target.value)}
              placeholder="Name this passkey (e.g. MacBook Touch ID)"
              className="flex-1"
            />
            <Button size="sm" disabled={addingPk} onClick={addPasskey}>
              {addingPk ? "Waiting for browser…" : "Add passkey"}
            </Button>
          </div>
          {!loadingPk && passkeys.length === 0 && (
            <p className="text-sm text-muted-foreground">You haven't registered any passkeys yet.</p>
          )}
          {passkeys.map((p, idx) => (
            <div key={p.id} className={idx > 0 ? "border-t pt-3" : undefined}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label>{p.name || "Unnamed passkey"}</Label>
                  <p className="text-sm text-muted-foreground">Added {formatRelative(p.createdAt)}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void removePasskey(p.id)}>
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// --------------------------------------------------------------------------
// Preferences (language + time zone)
// --------------------------------------------------------------------------

function PreferencesCard({ pushToast }: { pushToast: (m: string) => void }) {
  const { prefs, loading, refresh } = usePreferences();
  // "" = inherit the workspace default; a code = a personal override.
  const [locale, setLocale] = useState("");
  const [timezone, setTimezone] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Hydrate from the server payload once it lands.
  useEffect(() => {
    if (!prefs) return;
    setLocale(prefs.user.locale ?? "");
    setTimezone(prefs.user.timezone ?? "");
    setDirty(false);
  }, [prefs?.user.locale, prefs?.user.timezone]);

  const workspace = prefs?.workspace ?? {
    defaultLocale: "en",
    locales: ["en"],
    timezone: "UTC",
  };

  const languageOpts = useMemo(
    () => [
      {
        value: "",
        label: `Workspace default — ${localeLabel(workspace.defaultLocale)}`,
      },
      ...workspace.locales.map((code) => ({
        value: code,
        label: localeLabel(code),
      })),
    ],
    [workspace.defaultLocale, workspace.locales],
  );

  const timezoneOpts = useMemo(
    () => [
      { value: "", label: `Workspace default — ${workspace.timezone}` },
      ...timezoneOptions(),
    ],
    [workspace.timezone],
  );

  // Live preview of the *pending* selection (not yet saved).
  const previewLocale = locale || workspace.defaultLocale || "en";
  const previewTz = timezone || workspace.timezone || "UTC";
  const preview = useMemo(
    () => makeFormatters(previewLocale, previewTz).formatDateTime(new Date()),
    [previewLocale, previewTz],
  );

  const save = async () => {
    setSaving(true);
    try {
      await accountApi.patchPreferences({
        locale: locale || null,
        timezone: timezone || null,
      });
      await refresh();
      setDirty(false);
      pushToast("Preferences saved.");
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !prefs) {
    return (
      <Card className="max-w-3xl">
        <CardContent className="flex flex-col gap-4 pt-6">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-3xl">
      <CardContent className="flex flex-col gap-6 pt-6">
        <div className="flex flex-col gap-2">
          <Label>Language</Label>
          <Select
            value={locale}
            onChange={(v) => {
              setLocale(v);
              setDirty(true);
            }}
            options={languageOpts}
          />
          <p className="text-sm text-muted-foreground">
            Sets the locale used to format dates and numbers across the admin.
            Choose “Workspace default” to follow the workspace language.
          </p>
        </div>
        <Separator />
        <div className="flex flex-col gap-2">
          <Label>Time zone</Label>
          <Select
            value={timezone}
            onChange={(v) => {
              setTimezone(v);
              setDirty(true);
            }}
            options={timezoneOpts}
          />
          <p className="text-sm text-muted-foreground">
            Timestamps across the admin render in this zone.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Preview: </span>
          <span className="font-mono">{preview}</span>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => {
              setLocale(prefs?.user.locale ?? "");
              setTimezone(prefs?.user.timezone ?? "");
              setDirty(false);
            }}
          >
            Discard
          </Button>
          {/* Fixed min width so the label swap (Save ⇄ Saving…) doesn't
              resize the button and shove the Discard button sideways. */}
          <Button
            size="sm"
            className="min-w-[5.5rem]"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
