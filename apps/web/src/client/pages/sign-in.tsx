import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  KeyRoundIcon,
  MailIcon,
} from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import {
  AuthCard,
  AuthCardHeader,
  AuthDivider,
  AuthError,
  AuthFootLink,
  AuthOutline,
  AuthShell,
  AuthSubmit,
} from "@/components/auth-shell";
import { SocialButtons } from "@/components/social-buttons";
import { notifyError } from "@/lib/error";
import { auth } from "@/lib/auth";

const passkeysSupported = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.PublicKeyCredential !== "undefined";

export const SignIn = () => {
  const { t } = useLingui();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"email" | "passkey" | null>(null);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/";

  // Already signed in? Skip the form entirely.
  useEffect(() => {
    let cancelled = false;
    auth
      .getSession()
      .then((res) => {
        if (cancelled) return;
        const session = (res as { data?: { session?: unknown } })?.data?.session;
        if (session) navigate(next, { replace: true });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [navigate, next]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError(t`Enter your email and password.`);
      return;
    }
    setError(null);
    setBusy("email");
    const res = await auth.signIn.email({ email, password });
    if (res.error) {
      setError(res.error.message ?? t`Sign-in failed`);
      setBusy(null);
      return;
    }
    window.location.href = next;
  };

  const passkey = async () => {
    setError(null);
    setBusy("passkey");
    try {
      const c = auth as unknown as {
        signIn: {
          passkey?: (opts?: { autoFill?: boolean }) => Promise<{
            error?: { message?: string };
          }>;
        };
      };
      if (!c.signIn.passkey) {
        setError(t`Passkey plugin not enabled`);
        setBusy(null);
        return;
      }
      const res = await c.signIn.passkey({ autoFill: false });
      if (res?.error) {
        setError(res.error.message ?? t`Passkey sign-in failed`);
        setBusy(null);
        return;
      }
      window.location.href = next;
    } catch (e) {
      notifyError(e);
      setBusy(null);
    }
  };

  return (
    <AuthShell mode="sign-in">
      <AuthCard>
        <AuthCardHeader
          title={<Trans>Welcome back</Trans>}
          description={<Trans>Sign in with your email and password, or use a provider.</Trans>}
        />

        <SocialButtons callbackURL={next} />

        <AuthDivider><Trans>or with email</Trans></AuthDivider>

        {error && (
          <AuthError>
            <InfoIcon size={14} className="shrink-0" />
            <span>{error}</span>
          </AuthError>
        )}

        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="email"><Trans>Email</Trans></Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t`you@example.com`}
              className="h-10"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="password"><Trans>Password</Trans></Label>
              <Link
                to="/forgot"
                className="text-[11.5px] text-muted-foreground hover:text-foreground hover:underline"
              >
                <Trans>Forgot?</Trans>
              </Link>
            </div>
            <div className="relative">
              <Input
                id="password"
                type={show ? "text" : "password"}
                autoComplete="current-password webauthn"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="h-10 pr-10"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? t`Hide password` : t`Show password`}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              >
                {show ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
              </Button>
            </div>
          </div>

          <AuthSubmit type="submit" disabled={busy !== null}>
            {busy === "email" ? <Trans>Signing in…</Trans> : <Trans>Sign in</Trans>}
          </AuthSubmit>

          <AuthOutline asChild>
            <Link to="/magic-link">
              <MailIcon /> <Trans>Send a magic link instead</Trans>
            </Link>
          </AuthOutline>

          {passkeysSupported() && (
            <AuthOutline
              type="button"
              onClick={passkey}
              disabled={busy !== null}
            >
              <KeyRoundIcon />
              {busy === "passkey" ? <Trans>Signing in…</Trans> : <Trans>Sign in with passkey</Trans>}
            </AuthOutline>
          )}
        </form>

        <AuthFootLink
          to="/sign-up"
          prefix={t`Don't have an account?`}
          label={t`Sign up`}
        />
      </AuthCard>
    </AuthShell>
  );
};
