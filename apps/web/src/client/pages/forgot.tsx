import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { MoonIcon, SunIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@backlex/ui/components/button";
import {
  ForgotPage as BaseForgotPage,
  type AuthBranding,
  type AuthShellCopy,
  type ForgotCopy,
} from "@backlex/auth-ui";
import { useTheme } from "@/components/theme-provider";
import { notifyError } from "@/lib/error";
import { auth, useAuthSurface } from "@/lib/auth";
import { useWorkspaceBranding } from "@/lib/branding";
import { version as appVersion } from "../../../package.json";

/** OSS-admin wrapper around `<ForgotPage>` from `@backlex/auth-ui`. */
export const Forgot = () => {
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

  const copy: ForgotCopy = {
    title: <Trans>Reset your password</Trans>,
    description: (
      <Trans>Enter the email you signed up with — we'll send a reset link.</Trans>
    ),
    sentTitle: <Trans>Reset link sent</Trans>,
    sentDescription: (
      <Trans>Click the link in your inbox to set a new password. The token expires in 1 hour. Your existing password still works in the meantime.</Trans>
    ),
    backToSignIn: <Trans>Back to sign in</Trans>,
    emailLabel: <Trans>Email</Trans>,
    emailPlaceholder: t`you@example.com`,
    submit: <Trans>Send reset link</Trans>,
    submitBusy: <Trans>Sending…</Trans>,
    backLink: <Trans>← Back to sign in</Trans>,
    notEnabled: t`Password reset is not enabled on this instance`,
    sendFailed: t`Failed to send reset link`,
    sendContext: t`Sending reset link`,
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
    <BaseForgotPage
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
