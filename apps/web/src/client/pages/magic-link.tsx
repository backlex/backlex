import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { MoonIcon, SunIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@backlex/ui/components/button";
import {
  MagicLinkPage as BaseMagicLinkPage,
  type AuthBranding,
  type AuthShellCopy,
  type MagicLinkCopy,
} from "@backlex/auth-ui";
import { useTheme } from "@/components/theme-provider";
import { notifyError } from "@/lib/error";
import { auth, useAuthSurface } from "@/lib/auth";
import { useWorkspaceBranding } from "@/lib/branding";
import { version as appVersion } from "../../../package.json";

/** OSS-admin wrapper around `<MagicLinkPage>` from `@backlex/auth-ui`. */
export const MagicLink = () => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { surface } = useAuthSurface();
  const wsBranding = useWorkspaceBranding();
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";

  const branding: AuthBranding = {
    name: wsBranding?.workspaceName?.trim() || "backlex",
    logoUrl: wsBranding?.logoUrl ?? null,
  };

  const shellCopy: AuthShellCopy = {
    headline: <Trans>One-time link, no <em>password</em>.</Trans>,
    lede: (
      <Trans>A signed link will arrive in your inbox. Single-use, expires in 15 minutes.</Trans>
    ),
    signInLabel: t`Sign in`,
    signUpLabel: t`Sign up`,
    magicLinkLabel: t`Magic link`,
    claimInstanceLabel: t`Claim instance`,
    toggleTheme: t`Toggle theme`,
  };

  const copy: MagicLinkCopy = {
    title: <Trans>Magic link</Trans>,
    description: (
      <Trans>We'll email a single-use sign-in link. No password needed.</Trans>
    ),
    sentTitle: <Trans>Check your inbox</Trans>,
    sentBody: (displayEmail) => (
      <Trans>If {displayEmail} matches an account, a sign-in link is on its way. It expires in 15 minutes.</Trans>
    ),
    yourAddress: t`your address`,
    useDifferentEmail: <Trans>Use a different email</Trans>,
    backToSignIn: <Trans>Back to sign in</Trans>,
    emailLabel: <Trans>Email</Trans>,
    emailPlaceholder: t`you@example.com`,
    submit: <Trans>Send link</Trans>,
    submitBusy: <Trans>Sending…</Trans>,
    footPrefix: t`Prefer a password?`,
    footLabel: t`Sign in`,
    notEnabled: t`Magic-link plugin not enabled on the server`,
    sendFailed: t`Failed to send magic link`,
    sendContext: t`Sending magic link`,
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
    <BaseMagicLinkPage
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
