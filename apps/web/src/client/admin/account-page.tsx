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
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@backlex/ui/components/button";
import { Badge } from "@backlex/ui/components/badge";
import { Input } from "@backlex/ui/components/input";
import { Label } from "@backlex/ui/components/label";
import { Checkbox } from "@backlex/ui/components/checkbox";
import { Avatar, AvatarFallback, AvatarImage } from "@backlex/ui/components/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@backlex/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@backlex/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { Separator } from "@backlex/ui/components/separator";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { PageHeader } from "@/components/page-header";
import { auth } from "@/lib/auth";
import { api } from "@/lib/api";
import { accountApi } from "./api";
import { ADMIN_LOCALES } from "./i18n";
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
        title={<Trans>Account</Trans>}
        description={<Trans>Your personal profile, preferences, password, sessions, and connected credentials. Workspace-wide settings live under the Settings page.</Trans>}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as AccountTab)}>
        <TabsList>
          <TabsTrigger value="profile"><Trans>Profile</Trans></TabsTrigger>
          <TabsTrigger value="preferences"><Trans>Preferences</Trans></TabsTrigger>
          <TabsTrigger value="security"><Trans>Security</Trans></TabsTrigger>
          <TabsTrigger value="sessions"><Trans>Sessions</Trans></TabsTrigger>
          <TabsTrigger value="connected"><Trans>Connected</Trans></TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <ProfileCard user={sessionUser} pushToast={pushToast} refetch={() => session.refetch()} />
        </TabsContent>
        <TabsContent value="preferences">
          <PreferencesCard pushToast={pushToast} />
        </TabsContent>
        <TabsContent value="security" className="flex flex-col gap-4">
          <SecurityCard pushToast={pushToast} />
          <TwoFactorCard pushToast={pushToast} refetch={() => session.refetch()} />
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
  const { t } = useLingui();
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
      pushToast(t`Not signed in.`);
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
      pushToast(t`Profile saved.`);
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
            <Label><Trans>Avatar</Trans></Label>
            <p className="text-sm text-muted-foreground">
              <Trans>PNG, JPG or WebP. Shown in the header and on any author display.</Trans>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Avatar className="size-14">
              {previewSrc && <AvatarImage src={previewSrc} alt={t`Avatar preview`} />}
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
              {uploading ? <Trans>Uploading…</Trans> : image ? <Trans>Replace</Trans> : <Trans>Upload</Trans>}
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
                <Trans>Remove</Trans>
              </Button>
            )}
          </div>
        </div>
        <Separator />
        <div className="flex flex-col gap-2">
          <Label htmlFor="account-name"><Trans>Name</Trans></Label>
          <Input
            id="account-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            placeholder={t`Your display name`}
          />
          <p className="text-sm text-muted-foreground"><Trans>Shown in author bylines and the header dropdown.</Trans></p>
        </div>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Label><Trans>Email</Trans></Label>
            <p className="text-sm text-muted-foreground">
              <Trans>Email changes aren't supported yet — contact an admin if you need to switch addresses.</Trans>
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
            <Trans>Discard</Trans>
          </Button>
          {/* Fixed min width so the label swap (Save ⇄ Saving…) doesn't
              resize the button and shove the Discard button sideways. */}
          <Button
            size="sm"
            className="min-w-[5.5rem]"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
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
  const { t } = useLingui();
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
    if (newPw.length < 8) { pushToast(t`New password must be at least 8 characters.`); return; }
    if (newPw !== confirmPw) { pushToast(t`New password and confirmation don't match.`); return; }
    setSaving(true);
    try {
      if (hasPassword) {
        unwrap(await auth.changePassword({ currentPassword: oldPw, newPassword: newPw, revokeOtherSessions: revokeOthers }));
        pushToast(revokeOthers ? t`Password changed; other sessions signed out.` : t`Password changed.`);
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
        pushToast(t`Password set.`);
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
      pushToast(t`All other devices signed out.`);
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
            {hasPassword === false ? <Trans>Set a password</Trans> : <Trans>Change password</Trans>}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {hasPassword === false && (
            <p className="text-sm text-muted-foreground">
              <Trans>You signed in with a social provider. Setting a password lets you also sign in with email + password.</Trans>
            </p>
          )}
          {hasPassword !== false && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="old-pw"><Trans>Current password</Trans></Label>
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
            <Label htmlFor="new-pw"><Trans>New password</Trans></Label>
            <Input
              id="new-pw"
              type="password"
              autoComplete="new-password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
            />
            <p className="text-sm text-muted-foreground"><Trans>At least 8 characters.</Trans></p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirm-pw"><Trans>Confirm new password</Trans></Label>
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
              <Trans>Sign out from all other devices</Trans>
            </label>
          )}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={saving || !newPw || !confirmPw || (hasPassword !== false && !oldPw)}
              onClick={submitChange}
            >
              {saving ? <Trans>Saving…</Trans> : hasPassword === false ? <Trans>Set password</Trans> : <Trans>Update password</Trans>}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LogOutIcon className="size-4" />
            <Trans>Sign out elsewhere</Trans>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            <Trans>Revokes every active session except the one you're on right now.</Trans>
          </p>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" disabled={revoking} onClick={signOutOthers}>
              {revoking ? <Trans>Revoking…</Trans> : <Trans>Sign out other devices</Trans>}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// --------------------------------------------------------------------------
// Two-factor authentication (TOTP)
// --------------------------------------------------------------------------

/** Minimal typed view of better-auth's two-factor client methods (the OSS
 *  client exposes them via the twoFactorClient plugin; we reach them through a
 *  cast so this file doesn't depend on the plugin's exported types). */
type TwoFactorApi = {
  twoFactor: {
    enable: (i: { password: string }) => Promise<{
      data?: { totpURI?: string; backupCodes?: string[] } | null;
      error?: { message?: string } | null;
    }>;
    verifyTotp: (i: { code: string }) => Promise<{ error?: { message?: string } | null }>;
    disable: (i: { password: string }) => Promise<{ error?: { message?: string } | null }>;
    generateBackupCodes: (i: { password: string }) => Promise<{
      data?: { backupCodes?: string[] } | null;
      error?: { message?: string } | null;
    }>;
  };
};

/** Pull the base32 `secret` out of an `otpauth://totp/...` URI so we can show a
 *  manual-entry key for authenticator apps that don't scan a QR. */
const secretFromTotpUri = (uri: string): string => {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    const m = uri.match(/[?&]secret=([^&]+)/i);
    return m?.[1] ? decodeURIComponent(m[1]) : "";
  }
};

/** Group a secret into 4-char blocks so it's easier to type into an app. */
const groupSecret = (secret: string): string =>
  secret.replace(/(.{4})/g, "$1 ").trim();

function TwoFactorCard({
  pushToast,
  refetch,
}: {
  pushToast: (m: string) => void;
  refetch: () => void;
}) {
  const { t } = useLingui();
  const session = auth.useSession();
  const enabled = Boolean(
    (session.data as { user?: { twoFactorEnabled?: boolean } } | null)?.user
      ?.twoFactorEnabled,
  );

  // Enrolment is a two-step flow: enter password → get a secret + backup codes
  // (pending), then verify a code from the app to actually switch 2FA on.
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<{ secret: string; backupCodes: string[] } | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [busy, setBusy] = useState(false);
  // Disable flow.
  const [disabling, setDisabling] = useState(false);
  const [disablePw, setDisablePw] = useState("");
  // Backup-code regeneration flow (when 2FA is already on).
  const [regenPw, setRegenPw] = useState("");
  const [regenOpen, setRegenOpen] = useState(false);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);

  const begin = async () => {
    if (!password) {
      pushToast(t`Enter your password to continue.`);
      return;
    }
    setBusy(true);
    try {
      const res = await (auth as unknown as TwoFactorApi).twoFactor.enable({ password });
      if (res.error) throw new Error(res.error.message ?? "Could not start 2FA setup");
      const totpURI = res.data?.totpURI ?? "";
      const secret = secretFromTotpUri(totpURI);
      setPending({ secret, backupCodes: res.data?.backupCodes ?? [] });
      setPassword("");
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    const code = verifyCode.trim();
    if (!code) {
      pushToast(t`Enter the 6-digit code from your authenticator app.`);
      return;
    }
    setBusy(true);
    try {
      const res = await (auth as unknown as TwoFactorApi).twoFactor.verifyTotp({ code });
      if (res.error) throw new Error(res.error.message ?? "Invalid code");
      setPending(null);
      setVerifyCode("");
      refetch();
      pushToast(t`Two-factor authentication is on.`);
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!disablePw) {
      pushToast(t`Enter your password to turn off 2FA.`);
      return;
    }
    setBusy(true);
    try {
      const res = await (auth as unknown as TwoFactorApi).twoFactor.disable({ password: disablePw });
      if (res.error) throw new Error(res.error.message ?? "Could not disable 2FA");
      setDisabling(false);
      setDisablePw("");
      refetch();
      pushToast(t`Two-factor authentication is off.`);
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const copyBackupCodes = async () => {
    if (!pending?.backupCodes.length) return;
    try {
      await navigator.clipboard.writeText(pending.backupCodes.join("\n"));
      pushToast(t`Backup codes copied.`);
    } catch {
      pushToast(t`Couldn't copy — select and copy them manually.`);
    }
  };

  const regenerate = async () => {
    if (!regenPw) {
      pushToast(t`Enter your password to regenerate codes.`);
      return;
    }
    setBusy(true);
    try {
      const res = await (auth as unknown as TwoFactorApi).twoFactor.generateBackupCodes({ password: regenPw });
      if (res.error) throw new Error(res.error.message ?? "Could not regenerate codes");
      setFreshCodes(res.data?.backupCodes ?? []);
      setRegenPw("");
      setRegenOpen(false);
      pushToast(t`New backup codes generated. Old codes no longer work.`);
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const copyFreshCodes = async () => {
    if (!freshCodes?.length) return;
    try {
      await navigator.clipboard.writeText(freshCodes.join("\n"));
      pushToast(t`Backup codes copied.`);
    } catch {
      pushToast(t`Couldn't copy — select and copy them manually.`);
    }
  };

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldIcon className="size-4" />
          <Trans>Two-factor authentication</Trans>
          {enabled && <Badge><Trans>On</Trans></Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          <Trans>Add a one-time code from an authenticator app (Google Authenticator, Authy, 1Password…) as a second step when signing in.</Trans>
        </p>

        {/* Already enabled — offer to turn it off. */}
        {enabled && !pending && (
          disabling ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="2fa-disable-pw"><Trans>Confirm your password</Trans></Label>
              <Input
                id="2fa-disable-pw"
                type="password"
                autoComplete="current-password"
                value={disablePw}
                onChange={(e) => setDisablePw(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setDisabling(false); setDisablePw(""); }}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button variant="destructive" size="sm" disabled={busy} onClick={disable}>
                  {busy ? <Trans>Turning off…</Trans> : <Trans>Turn off 2FA</Trans>}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label><Trans>Backup codes</Trans></Label>
                <p className="text-xs text-muted-foreground">
                  <Trans>Lost your codes or running low? Generate a fresh set — the old codes stop working immediately.</Trans>
                </p>
                {freshCodes && (
                  <div className="mt-1 flex flex-col gap-1.5">
                    <div className="grid grid-cols-2 gap-1 rounded-control bg-muted p-3 font-mono text-sm">
                      {freshCodes.map((code) => (
                        <span key={code} className="select-all">{code}</span>
                      ))}
                    </div>
                    <div className="flex justify-end">
                      <Button variant="ghost" size="sm" onClick={copyFreshCodes}>
                        <Trans>Copy</Trans>
                      </Button>
                    </div>
                  </div>
                )}
                {regenOpen ? (
                  <div className="mt-1 flex items-center gap-2">
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={regenPw}
                      onChange={(e) => setRegenPw(e.target.value)}
                      placeholder={t`Confirm your password`}
                      className="flex-1"
                    />
                    <Button size="sm" disabled={busy} onClick={regenerate}>
                      {busy ? <Trans>Generating…</Trans> : <Trans>Generate</Trans>}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setRegenOpen(false); setRegenPw(""); }}>
                      <Trans>Cancel</Trans>
                    </Button>
                  </div>
                ) : (
                  <div className="mt-1">
                    <Button variant="outline" size="sm" onClick={() => { setRegenOpen(true); setFreshCodes(null); }}>
                      <Trans>Regenerate backup codes</Trans>
                    </Button>
                  </div>
                )}
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  <Trans>Turn off two-factor authentication.</Trans>
                </p>
                <Button variant="outline" size="sm" onClick={() => setDisabling(true)}>
                  <Trans>Turn off</Trans>
                </Button>
              </div>
            </div>
          )
        )}

        {/* Not enabled, not yet started — password gate to begin enrolment. */}
        {!enabled && !pending && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="2fa-pw"><Trans>Confirm your password to begin</Trans></Label>
            <div className="flex items-center gap-2">
              <Input
                id="2fa-pw"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t`Your password`}
                className="flex-1"
              />
              <Button size="sm" disabled={busy} onClick={begin}>
                {busy ? <Trans>Starting…</Trans> : <Trans>Set up</Trans>}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              <Trans>Requires a password on your account. Social-only users should set one above first.</Trans>
            </p>
          </div>
        )}

        {/* Pending verification — show the manual key + backup codes, then verify. */}
        {pending && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label><Trans>1. Add this key to your authenticator app</Trans></Label>
              <code className="select-all rounded-control bg-muted px-3 py-2 font-mono text-sm tracking-wider">
                {groupSecret(pending.secret) || "—"}
              </code>
              <p className="text-xs text-muted-foreground">
                <Trans>In Google Authenticator choose “Enter a setup key”, paste the key above, and pick “Time based”.</Trans>
              </p>
            </div>

            {pending.backupCodes.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label><Trans>2. Save your backup codes</Trans></Label>
                  <Button variant="ghost" size="sm" onClick={copyBackupCodes}>
                    <Trans>Copy</Trans>
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-1 rounded-control bg-muted p-3 font-mono text-sm">
                  {pending.backupCodes.map((c) => (
                    <span key={c} className="select-all">{c}</span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  <Trans>Each code works once if you lose your authenticator. Store them somewhere safe — they won't be shown again.</Trans>
                </p>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="2fa-verify"><Trans>3. Enter a code to confirm</Trans></Label>
              <div className="flex items-center gap-2">
                <Input
                  id="2fa-verify"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                  placeholder={t`123456`}
                  className="flex-1"
                />
                <Button size="sm" disabled={busy} onClick={confirm}>
                  {busy ? <Trans>Verifying…</Trans> : <Trans>Verify &amp; enable</Trans>}
                </Button>
              </div>
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => { setPending(null); setVerifyCode(""); }}
                >
                  <Trans>Cancel</Trans>
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
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
  const { t } = useLingui();
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
        device: (s.userAgent ?? t`unknown agent`).slice(0, 64),
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
  }, [currentToken, pushToast, t]);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (token: string, label: string) => {
    try {
      unwrap(await auth.revokeSession({ token }));
      setSessions((arr) => arr.filter((s) => s.token !== token));
      pushToast(t`Session ${label} revoked.`);
    } catch (e) {
      pushToast(errMsg(e));
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ActivityIcon className="size-4" />
          <Trans>Active sessions</Trans>
          <span className="font-mono text-xs text-muted-foreground">
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </span>
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          {loading ? <Trans>Refreshing…</Trans> : <Trans>Refresh</Trans>}
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead><Trans>Device</Trans></TableHead>
              <TableHead><Trans>IP</Trans></TableHead>
              <TableHead><Trans>Created</Trans></TableHead>
              <TableHead><Trans>Last seen</Trans></TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loading && sessions.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  <Trans>No active sessions.</Trans>
                </TableCell>
              </TableRow>
            )}
            {sessions.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  {s.device}
                  {s.current && <Badge className="ml-2"><Trans>current</Trans></Badge>}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{s.ip}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{formatDateTime(s.createdAt)}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{formatRelative(s.lastAt)}</TableCell>
                <TableCell className="text-right">
                  {!s.current && (
                    <Button size="sm" variant="ghost" onClick={() => void revoke(s.token, s.id.slice(0, 6) + "…")}>
                      <Trans>Revoke</Trans>
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
  const { t } = useLingui();
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
      pushToast(t`Linked ${PROVIDER_LABELS[provider] ?? provider}.`);
    } catch (e) {
      pushToast(errMsg(e));
    } finally {
      setLinking(null);
    }
  };

  const unlink = async (account: LinkedAccount) => {
    if (accounts.length <= 1) {
      pushToast(t`Can't unlink your only sign-in method.`);
      return;
    }
    try {
      unwrap(await auth.unlinkAccount({ accountId: account.id, providerId: account.providerId }));
      setAccounts((arr) => arr.filter((a) => a.id !== account.id));
      pushToast(t`Unlinked ${PROVIDER_LABELS[account.providerId] ?? account.providerId}.`);
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
      pushToast(t`Passkey added.`);
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
      pushToast(t`Passkey removed.`);
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
            <Trans>Social sign-in</Trans>
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
                <Trans>No social providers are enabled for this workspace.</Trans>
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
                      {linked ? <Trans>Linked — you can sign in with this provider.</Trans> : <Trans>Not linked.</Trans>}
                    </p>
                  </div>
                  {linked ? (
                    <Button size="sm" variant="ghost" onClick={() => void unlink(linked)}>
                      <Trans>Unlink</Trans>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={linking === id}
                      onClick={() => void link(id)}
                    >
                      {linking === id ? <Trans>Redirecting…</Trans> : <Trans>Link</Trans>}
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
            <Trans>Passkeys</Trans>
            <span className="font-mono text-xs text-muted-foreground">{passkeys.length}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            <Trans>Sign in with Touch ID, Face ID, a Windows Hello PIN, or a hardware security key.</Trans>
          </p>
          <div className="flex items-center gap-2">
            <Input
              value={newPkName}
              onChange={(e) => setNewPkName(e.target.value)}
              placeholder={t`Name this passkey (e.g. MacBook Touch ID)`}
              className="flex-1"
            />
            <Button size="sm" disabled={addingPk} onClick={addPasskey}>
              {addingPk ? <Trans>Waiting for browser…</Trans> : <Trans>Add passkey</Trans>}
            </Button>
          </div>
          {!loadingPk && passkeys.length === 0 && (
            <p className="text-sm text-muted-foreground"><Trans>You haven't registered any passkeys yet.</Trans></p>
          )}
          {passkeys.map((p, idx) => (
            <div key={p.id} className={idx > 0 ? "border-t pt-3" : undefined}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label>{p.name || <Trans>Unnamed passkey</Trans>}</Label>
                  <p className="text-sm text-muted-foreground"><Trans>Added {formatRelative(p.createdAt)}</Trans></p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => void removePasskey(p.id)}>
                  <Trans>Remove</Trans>
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
  const { t } = useLingui();
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

  // The picker offers only locales the admin SPA actually ships a translation
  // for (`ADMIN_LOCALES`) — not the workspace's content-translation list
  // (`i18nLocales`), which may include languages with no `.po` catalog. A code
  // stored before this list was scoped is kept selectable so the picker still
  // reflects the saved value instead of rendering blank.
  const languageOpts = useMemo<{ value: string; label: string }[]>(() => {
    const opts: { value: string; label: string }[] = [
      {
        value: "",
        label: t`Workspace default — ${localeLabel(workspace.defaultLocale)}`,
      },
      ...ADMIN_LOCALES.map((code) => ({
        value: code as string,
        label: localeLabel(code),
      })),
    ];
    if (locale && !(ADMIN_LOCALES as readonly string[]).includes(locale)) {
      opts.push({ value: locale, label: localeLabel(locale) });
    }
    return opts;
  }, [workspace.defaultLocale, locale, t]);

  const timezoneOpts = useMemo(
    () => [
      { value: "", label: t`Workspace default — ${workspace.timezone}` },
      ...timezoneOptions(),
    ],
    [workspace.timezone, t],
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
      pushToast(t`Preferences saved.`);
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
          <Label><Trans>Language</Trans></Label>
          <Select
            value={locale}
            onChange={(v) => {
              setLocale(v);
              setDirty(true);
            }}
            options={languageOpts}
          />
          <p className="text-sm text-muted-foreground">
            <Trans>Sets the admin display language and how dates and numbers are
            formatted. Only languages with a bundled translation are listed.</Trans>
          </p>
        </div>
        <Separator />
        <div className="flex flex-col gap-2">
          <Label><Trans>Time zone</Trans></Label>
          <Select
            value={timezone}
            onChange={(v) => {
              setTimezone(v);
              setDirty(true);
            }}
            options={timezoneOpts}
          />
          <p className="text-sm text-muted-foreground">
            <Trans>Timestamps across the admin render in this zone.</Trans>
          </p>
        </div>
        <div className="rounded-surface border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="text-muted-foreground"><Trans>Preview: </Trans></span>
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
            <Trans>Discard</Trans>
          </Button>
          {/* Fixed min width so the label swap (Save ⇄ Saving…) doesn't
              resize the button and shove the Discard button sideways. */}
          <Button
            size="sm"
            className="min-w-[5.5rem]"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
