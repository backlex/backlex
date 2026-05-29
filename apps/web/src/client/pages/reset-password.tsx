import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { MoonIcon, SunIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@backlex/ui/components/button";
import {
  ResetPasswordPage as BaseResetPasswordPage,
  type AuthBranding,
  type AuthShellCopy,
  type ResetPasswordCopy,
} from "@backlex/auth-ui";
import { useTheme } from "@/components/theme-provider";
import { notifyError } from "@/lib/error";
import { auth, useAuthSurface } from "@/lib/auth";
import { useWorkspaceBranding } from "@/lib/branding";
import { version as appVersion } from "../../../package.json";

/** OSS-admin wrapper around `<ResetPasswordPage>` from `@backlex/auth-ui`. */
export const ResetPassword = () => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { surface } = useAuthSurface();
  const wsBranding = useWorkspaceBranding();
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";

  const branding: AuthBranding = {
    name: wsBranding?.workspaceName?.trim() || "workeros",
    logoUrl: wsBranding?.logoUrl ?? null,
  };

  const shellCopy: AuthShellCopy = {
    headline: <Trans>Reset your <em>password</em>.</Trans>,
    lede: (
      <Trans>We'll email a reset link. Until you click it, your existing password still works.</Trans>
    ),
    signInLabel: t`Sign in`,
    signUpLabel: t`Sign up`,
    magicLinkLabel: t`Magic link`,
    claimInstanceLabel: t`Claim instance`,
    toggleTheme: t`Toggle theme`,
  };

  const copy: ResetPasswordCopy = {
    title: <Trans>Choose a new password</Trans>,
    description: (
      <Trans>Set a new password for your account — at least 8 characters.</Trans>
    ),
    invalidTitle: <Trans>Reset link invalid</Trans>,
    invalidDescription: (
      <Trans>This password reset link is missing its token or has expired. Request a new one and try again.</Trans>
    ),
    requestNewLink: <Trans>Request a new link</Trans>,
    newPasswordLabel: <Trans>New password</Trans>,
    confirmPasswordLabel: <Trans>Confirm password</Trans>,
    submit: <Trans>Set new password</Trans>,
    submitBusy: <Trans>Saving…</Trans>,
    backLink: <Trans>← Back to sign in</Trans>,
    passwordTooShort: t`Password must be at least 8 characters`,
    passwordsDoNotMatch: t`Passwords do not match`,
    notEnabled: t`Password reset is not enabled on this instance`,
    resetFailed: t`Failed to reset password`,
    resetContext: t`Resetting password`,
  };

  const themeToggle = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={shellCopy.toggleTheme}
      title={shellCopy.toggleTheme}
      className="text-muted-foreground"
    >
      {dark ? <SunIcon size={14} /> : <MoonIcon size={14} />}
    </Button>
  );

  return (
    <BaseResetPasswordPage
      authClient={auth}
      navigate={(to, opts) => navigate(to, opts)}
      searchParam={(k) => params.get(k)}
      Link={({ to, className, children }) => (
        <Link to={to} className={className}>
          {children}
        </Link>
      )}
      notify={(msg, ctx) => notifyError(msg, ctx)}
      copy={copy}
      shellCopy={shellCopy}
      branding={branding}
      surface={surface ?? null}
      appVersion={appVersion}
      themeToggle={themeToggle}
    />
  );
};
