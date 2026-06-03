import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Trans, useLingui } from "@lingui/react/macro";
import { MailCheckIcon, AlertTriangleIcon } from "lucide-react";
import { Input } from "@backlex/ui/components/input";
import { Label } from "@backlex/ui/components/label";
import {
  AuthShell,
  AuthCard,
  AuthCardHeader,
  AuthCallout,
  AuthSubmit,
  AuthFootLink,
  type AuthBranding,
  type AuthShellCopy,
} from "@backlex/auth-ui";
import { api, ApiError } from "@/lib/api";
import { auth } from "@/lib/auth";
import { notifyError } from "@/lib/error";
import { useWorkspaceBranding } from "@/lib/branding";
import { version as appVersion } from "../../../package.json";

interface InviteMeta {
  email: string;
  workspaceName: string;
  expired: boolean;
}

type State =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "expired"; meta: InviteMeta }
  | { kind: "ready"; meta: InviteMeta };

/**
 * Invite-acceptance screen. Reached from the `${APP_URL}/invite?token=…` link in
 * a workspace invite email. Resolves the token to its (locked) email + workspace
 * via the public `GET /api/tenants/invite/:token`, then lets the invitee set a
 * password and create their account — the server admits this even while public
 * sign-up is closed (the invite is the authorisation), and `onUserCreated` binds
 * the workspace membership automatically.
 */
export const Invite = () => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const wsBranding = useWorkspaceBranding();
  const token = params.get("token") ?? "";

  const [state, setState] = useState<State>({ kind: "loading" });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setState({ kind: "invalid" });
      return;
    }
    void (async () => {
      try {
        const r = await api<{ data: InviteMeta }>(
          `/api/tenants/invite/${encodeURIComponent(token)}`,
        );
        if (cancelled) return;
        setState(r.data.expired ? { kind: "expired", meta: r.data } : { kind: "ready", meta: r.data });
      } catch (err) {
        if (cancelled) return;
        // 404 (unknown token) and any other failure both surface as "invalid".
        if (!(err instanceof ApiError)) notifyError(err);
        setState({ kind: "invalid" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const branding: AuthBranding = {
    name: wsBranding?.workspaceName?.trim() || "backlex",
    logoUrl: wsBranding?.logoUrl ?? null,
  };

  const shellCopy: AuthShellCopy = {
    headline: <Trans>Join the <em>team</em>.</Trans>,
    lede: <Trans>You've been invited to a backlex workspace. Set a password to finish creating your account.</Trans>,
    signInLabel: t`Sign in`,
    signUpLabel: t`Sign up`,
    magicLinkLabel: t`Magic link`,
    claimInstanceLabel: t`Claim instance`,
    toggleTheme: t`Toggle theme`,
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (state.kind !== "ready") return;
    if (password.length < 8) {
      notifyError(t`Password must be at least 8 characters.`);
      return;
    }
    setBusy(true);
    const email = state.meta.email;
    const res = await auth.signUp.email({
      email,
      password,
      name: name.trim() || email.split("@")[0] || "member",
    });
    if (res.error) {
      setBusy(false);
      notifyError(res.error.message ?? t`Sign-up failed`);
      return;
    }
    // autoSignIn gives a session; the server already bound the workspace
    // membership in onUserCreated. Land in the admin.
    navigate("/", { replace: true });
  };

  return (
    <AuthShell
      mode="sign-up"
      branding={branding}
      copy={shellCopy}
      appVersion={appVersion}
      Link={({ to, className, children }) => (
        <Link to={to} className={className}>
          {children}
        </Link>
      )}
    >
      <AuthCard>
        {state.kind === "loading" && (
          <AuthCardHeader
            title={<Trans>Checking your invite…</Trans>}
            description={<Trans>One moment.</Trans>}
          />
        )}

        {state.kind === "invalid" && (
          <>
            <AuthCardHeader
              title={<Trans>Invite not found</Trans>}
              description={<Trans>This invite link is invalid or has already been used.</Trans>}
            />
            <AuthCallout icon={<AlertTriangleIcon size={16} />}>
              <Trans>Ask an admin to send you a fresh invite, or sign in if you already have an account.</Trans>
            </AuthCallout>
            <AuthFootLink to="/sign-in" prefix={t`Have an account?`} label={t`Sign in`} Link={({ to, className, children }) => (
              <Link to={to} className={className}>{children}</Link>
            )} />
          </>
        )}

        {state.kind === "expired" && (
          <>
            <AuthCardHeader
              title={<Trans>Invite expired</Trans>}
              description={<Trans>This invite to {state.meta.workspaceName} has expired.</Trans>}
            />
            <AuthCallout icon={<AlertTriangleIcon size={16} />}>
              <Trans>Invites are valid for 7 days. Ask an admin to send a new one.</Trans>
            </AuthCallout>
            <AuthFootLink to="/sign-in" prefix={t`Have an account?`} label={t`Sign in`} Link={({ to, className, children }) => (
              <Link to={to} className={className}>{children}</Link>
            )} />
          </>
        )}

        {state.kind === "ready" && (
          <>
            <AuthCardHeader
              title={<Trans>Join {state.meta.workspaceName}</Trans>}
              description={<Trans>Set a password to accept the invite and create your account.</Trans>}
            />
            <AuthCallout icon={<MailCheckIcon size={16} />}>
              <Trans>You're joining as <span className="font-mono">{state.meta.email}</span>.</Trans>
            </AuthCallout>
            <form className="space-y-4" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor="invite-email"><Trans>Email</Trans></Label>
                <Input id="invite-email" type="email" value={state.meta.email} readOnly disabled className="h-10" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-name">
                  <Trans>Display name <span className="text-muted-foreground font-normal">(optional)</span></Trans>
                </Label>
                <Input
                  id="invite-name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t`Rana`}
                  className="h-10"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-password"><Trans>Password</Trans></Label>
                <Input
                  id="invite-password"
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t`At least 8 characters`}
                  className="h-10"
                />
              </div>
              <AuthSubmit type="submit" disabled={busy}>
                {busy ? <Trans>Creating account…</Trans> : <Trans>Accept invite</Trans>}
              </AuthSubmit>
            </form>
            <AuthFootLink to="/sign-in" prefix={t`Already have an account?`} label={t`Sign in`} Link={({ to, className, children }) => (
              <Link to={to} className={className}>{children}</Link>
            )} />
          </>
        )}
      </AuthCard>
    </AuthShell>
  );
};
