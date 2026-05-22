import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { MoonIcon, SunIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@workeros/ui/components/button";
import { version as appVersion } from "../../../package.json";
import { useTheme } from "@/components/theme-provider";
import { useAuthSurface } from "@/lib/auth";
import "./auth-shell.css";
import { useWorkspaceBranding } from "@/lib/branding";

export type AuthMode = "sign-in" | "sign-up" | "magic" | "forgot" | "claim";

interface AuthShellProps {
  mode: AuthMode;
  children: ReactNode;
}

interface ModeCopy {
  headline: ReactNode;
  lede: ReactNode;
}

const MODE_LINKS: Array<{ mode: AuthMode; to: string; labelKey: string }> = [
  { mode: "sign-in", to: "/sign-in", labelKey: "Sign in" },
  { mode: "sign-up", to: "/sign-up", labelKey: "Sign up" },
  { mode: "magic", to: "/magic-link", labelKey: "Magic link" },
  { mode: "claim", to: "/sign-up?claim=1", labelKey: "Claim instance" },
];

export const AuthShell = ({ mode, children }: AuthShellProps) => {
  const { t } = useLingui();
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";
  const { surface } = useAuthSurface();
  const wsBranding = useWorkspaceBranding();
  // Brand lockup: uploaded logo + admin-set workspace name when configured,
  // else the bundled "w" mark and "workeros" wordmark.
  const brandName = wsBranding?.workspaceName?.trim() || "workeros";
  const brandLogo = wsBranding?.logoUrl ?? null;

  const COPY: Record<AuthMode, ModeCopy> = {
    "sign-in": {
      headline: (
        <>
          <Trans>Sign in to <em>workeros</em>.</Trans>
        </>
      ),
      lede: (
        <Trans>Better-auth-style cookies. Sessions stored in your collections database — same DSL as everything else.</Trans>
      ),
    },
    "sign-up": {
      headline: (
        <>
          <Trans>Create your <em>workeros</em> account.</Trans>
        </>
      ),
      lede: (
        <Trans>Email is the only required field. Roles assigned post-signup — first user gets admin.</Trans>
      ),
    },
    magic: {
      headline: (
        <>
          <Trans>One-time link, no <em>password</em>.</Trans>
        </>
      ),
      lede: (
        <Trans>A signed link will arrive in your inbox. Single-use, expires in 15 minutes.</Trans>
      ),
    },
    forgot: {
      headline: (
        <>
          <Trans>Reset your <em>password</em>.</Trans>
        </>
      ),
      lede: (
        <Trans>We'll email a reset link. Until you click it, your existing password still works.</Trans>
      ),
    },
    claim: {
      headline: (
        <>
          <Trans>You're the <em>first</em>. Claim this instance.</Trans>
        </>
      ),
      lede: (
        <Trans>Detected an empty users table. The first account on a fresh instance is provisioned as admin automatically.</Trans>
      ),
    },
  };

  const copy = COPY[mode];
  // Admins can override the sign-in screen's headline/tagline from
  // Settings → Appearance; a blank value falls back to the default copy.
  const branding = surface?.branding;
  const headline: ReactNode =
    mode === "sign-in" && branding?.signInHeadline?.trim()
      ? branding.signInHeadline
      : copy.headline;
  const lede: ReactNode =
    mode === "sign-in" && branding?.signInTagline?.trim()
      ? branding.signInTagline
      : copy.lede;

  // The "Claim instance" link only exists when the server confirms the
  // instance has zero users. Once an admin exists it disappears everywhere
  // — the sign-up page itself also stops honouring `?claim=1`.
  const visibleLinks = MODE_LINKS.filter(
    (l) => l.mode !== "claim" || surface?.firstUserMode === true,
  );

  const linkLabels: Record<string, string> = {
    "Sign in": t`Sign in`,
    "Sign up": t`Sign up`,
    "Magic link": t`Magic link`,
    "Claim instance": t`Claim instance`,
  };

  return (
    <div className="grid min-h-svh w-full grid-cols-1 bg-background text-foreground md:grid-cols-2">
      {/* Left: brand panel */}
      <div
        className="auth-brand relative hidden flex-col overflow-hidden border-r border-border p-8 md:flex md:p-10"
        style={{
          background:
            "radial-gradient(900px 500px at 110% 0%, color-mix(in oklab, var(--primary) 22%, transparent), transparent 60%), linear-gradient(180deg, color-mix(in oklab, var(--primary) 6%, var(--card)) 0%, var(--card) 100%)",
        }}
      >
        {/* Animated primary light beams — diagonal sweep behind the brand copy. */}
        <div className="auth-beams" aria-hidden="true">
          <div className="beam beam-back" />
          <div className="beam beam-mid" />
          <div className="beam beam-front" />
          <div className="beam-grain" />
        </div>
        <div className="flex items-center gap-2.5 font-mono text-sm font-semibold tracking-tight">
          {brandLogo ? (
            <img
              src={brandLogo}
              alt=""
              className="size-7 rounded-lg object-contain"
            />
          ) : (
            <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground text-xs font-bold">
              {brandName.charAt(0).toLowerCase()}
            </span>
          )}
          {brandName}
        </div>

        <h1 className="mt-auto mb-3 text-balance text-4xl font-semibold leading-[1.05] tracking-tight">
          <BrandHeadline>{headline}</BrandHeadline>
        </h1>
        <p className="max-w-[36ch] text-[15px] leading-snug text-muted-foreground">
          {lede}
        </p>

        <div className="mt-auto flex gap-4 pt-6 font-mono text-xs text-muted-foreground">
          <span>v{appVersion}</span>
        </div>
      </div>

      {/* Right: form panel */}
      <div className="relative flex items-center justify-center p-6 md:p-10">
        <div className="relative w-full max-w-[380px]">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setTheme(dark ? "light" : "dark")}
            aria-label={t`Toggle theme`}
            title={t`Toggle theme`}
            className="absolute -top-7 right-0 text-muted-foreground"
          >
            {dark ? <SunIcon size={14} /> : <MoonIcon size={14} />}
          </Button>
          {children}
          <div className="mt-7 flex justify-center gap-4 text-xs text-muted-foreground">
            {visibleLinks.map((link) => (
              <Link
                key={link.mode}
                to={link.to}
                className={
                  mode === link.mode
                    ? "font-medium text-foreground"
                    : "hover:text-foreground"
                }
              >
                {linkLabels[link.labelKey] ?? link.labelKey}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Renders the headline so `<em>` becomes the chartreuse-primary highlight.
 * The design system reserves italic for this brand emphasis only.
 */
const BrandHeadline = ({ children }: { children: ReactNode }) => (
  <span className="[&_em]:not-italic [&_em]:text-primary">{children}</span>
);

/** Reusable card body container for individual auth screens. */
export const AuthCard = ({ children }: { children: ReactNode }) => (
  <div className="flex w-full flex-col gap-5">{children}</div>
);

/** Header block (h2 + sub) used inside AuthCard. */
export const AuthCardHeader = ({
  title,
  description,
}: {
  title: ReactNode;
  description?: ReactNode;
}) => (
  <div className="space-y-1">
    <h2 className="text-[24px] font-semibold leading-tight tracking-tight">
      {title}
    </h2>
    {description && (
      <p className="text-[13.5px] leading-relaxed text-muted-foreground">
        {description}
      </p>
    )}
  </div>
);

/** Horizontal "or with email" divider. */
export const AuthDivider = ({ children }: { children: ReactNode }) => (
  <div className="flex items-center gap-2.5 text-[11px] uppercase tracking-wider text-muted-foreground">
    <span className="h-px flex-1 bg-border" />
    {children}
    <span className="h-px flex-1 bg-border" />
  </div>
);

/** Inline notice card for first-user guidance. */
export const AuthCallout = ({
  icon,
  children,
}: {
  icon?: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex items-start gap-2.5 rounded-2xl border border-primary/35 bg-primary/8 px-3.5 py-3 text-[12.5px] leading-relaxed">
    {icon && <span className="mt-0.5 shrink-0 text-primary">{icon}</span>}
    <div>{children}</div>
  </div>
);

interface AuthErrorProps {
  children: ReactNode;
}

export const AuthError = ({ children }: AuthErrorProps) => (
  <div className="flex items-center gap-2 rounded-2xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
    {children}
  </div>
);

/** Mode footer link rendered inside individual cards. */
export const AuthFootLink = ({
  to,
  prefix,
  label,
}: {
  to: string;
  prefix: string;
  label: string;
}) => (
  <p className="text-center text-[12.5px] text-muted-foreground">
    {prefix}{" "}
    <Link
      to={to}
      className="font-medium text-foreground underline-offset-4 hover:underline"
    >
      {label}
    </Link>
  </p>
);

/** Tall, full-width primary action used by every auth form. */
export const AuthSubmit = ({
  children,
  ...rest
}: React.ComponentProps<typeof Button>) => (
  <Button
    {...rest}
    className="h-10 w-full justify-center"
    size="lg"
  >
    {children}
  </Button>
);

/** Tall, full-width outline alt action (magic link / second CTA). */
export const AuthOutline = ({
  children,
  ...rest
}: React.ComponentProps<typeof Button>) => (
  <Button
    {...rest}
    variant="outline"
    className="h-10 w-full justify-center"
    size="lg"
  >
    {children}
  </Button>
);
