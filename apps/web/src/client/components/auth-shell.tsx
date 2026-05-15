import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@workeros/ui/components/button";
import { useTheme } from "@/components/theme-provider";
import { useAuthSurface } from "@/lib/auth";

export type AuthMode = "sign-in" | "sign-up" | "magic" | "forgot" | "claim";

interface AuthShellProps {
  mode: AuthMode;
  children: ReactNode;
}

interface Snippet {
  label: string;
  body: ReactNode;
}

interface ModeCopy {
  headline: ReactNode;
  lede: string;
  snippets: Snippet[];
}

const COPY: Record<AuthMode, ModeCopy> = {
  "sign-in": {
    headline: (
      <>
        Sign in to <em>workeros</em>.
      </>
    ),
    lede:
      "Better-auth-style cookies. Sessions stored in your collections database — same DSL as everything else.",
    snippets: [
      {
        label: "POST",
        body: <span className="text-muted-foreground">/api/auth/sign-in/email</span>,
      },
      {
        label: "cookie",
        body: (
          <>
            <span className="text-muted-foreground">workeros_session=</span>
            <span>eyJhbGciOiJIUz…</span>
          </>
        ),
      },
      {
        label: "redirect",
        body: <span>/admin</span>,
      },
    ],
  },
  "sign-up": {
    headline: (
      <>
        Create your <em>workeros</em> account.
      </>
    ),
    lede:
      "Email is the only required field. Roles assigned post-signup — first user gets admin.",
    snippets: [
      {
        label: "POST",
        body: <span className="text-muted-foreground">/api/auth/sign-up/email</span>,
      },
      {
        label: "role",
        body: (
          <>
            <span>authenticated</span>{" "}
            <span className="text-muted-foreground">(or admin if first)</span>
          </>
        ),
      },
      {
        label: "event",
        body: <span className="text-muted-foreground">user.created</span>,
      },
    ],
  },
  magic: {
    headline: (
      <>
        One-time link, no <em>password</em>.
      </>
    ),
    lede:
      "A signed link will arrive in your inbox. Single-use, expires in 15 minutes.",
    snippets: [
      {
        label: "POST",
        body: <span className="text-muted-foreground">/api/auth/sign-in/magic-link</span>,
      },
      { label: "expires", body: <span>15m</span> },
      {
        label: "transport",
        body: <span className="text-muted-foreground">email · single-use jwt</span>,
      },
    ],
  },
  forgot: {
    headline: (
      <>
        Reset your <em>password</em>.
      </>
    ),
    lede:
      "We'll email a reset link. Until you click it, your existing password still works.",
    snippets: [
      {
        label: "POST",
        body: <span className="text-muted-foreground">/api/auth/forget-password</span>,
      },
      {
        label: "token",
        body: (
          <>
            <span>reset_xxx</span>{" "}
            <span className="text-muted-foreground">· expires 1h</span>
          </>
        ),
      },
      {
        label: "audit",
        body: <span className="text-muted-foreground">password.reset_requested</span>,
      },
    ],
  },
  claim: {
    headline: (
      <>
        You're the <em>first</em>. Claim this instance.
      </>
    ),
    lede:
      "Detected an empty users table. The first account on a fresh instance is provisioned as admin automatically.",
    snippets: [
      {
        label: "detect",
        body: <span className="text-muted-foreground">SELECT count(*) FROM users → 0</span>,
      },
      {
        label: "role",
        body: (
          <>
            <span>admin</span>{" "}
            <span className="text-muted-foreground">(first user policy)</span>
          </>
        ),
      },
      {
        label: "next",
        body: <span className="text-muted-foreground">create your first collection</span>,
      },
    ],
  },
};

const MODE_LINKS: Array<{ mode: AuthMode; to: string; label: string }> = [
  { mode: "sign-in", to: "/sign-in", label: "Sign in" },
  { mode: "sign-up", to: "/sign-up", label: "Sign up" },
  { mode: "magic", to: "/magic-link", label: "Magic link" },
  { mode: "claim", to: "/sign-up?claim=1", label: "Claim instance" },
];

export const AuthShell = ({ mode, children }: AuthShellProps) => {
  const copy = COPY[mode];
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";
  const { surface } = useAuthSurface();
  // The "Claim instance" link only exists when the server confirms the
  // instance has zero users. Once an admin exists it disappears everywhere
  // — the sign-up page itself also stops honouring `?claim=1`.
  const visibleLinks = MODE_LINKS.filter(
    (l) => l.mode !== "claim" || surface?.firstUserMode === true,
  );

  return (
    <div className="grid min-h-svh w-full grid-cols-1 bg-background text-foreground md:grid-cols-2">
      {/* Left: brand panel */}
      <div
        className="relative hidden flex-col overflow-hidden border-r border-border p-8 md:flex md:p-10"
        style={{
          background:
            "radial-gradient(900px 500px at 110% 0%, color-mix(in oklab, var(--primary) 22%, transparent), transparent 60%), linear-gradient(180deg, color-mix(in oklab, var(--primary) 6%, var(--card)) 0%, var(--card) 100%)",
        }}
      >
        <div className="flex items-center gap-2.5 font-mono text-sm font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground text-xs font-bold">
            w
          </span>
          workeros
        </div>

        <h1 className="mt-auto mb-3 text-balance text-4xl font-semibold leading-[1.05] tracking-tight">
          <BrandHeadline>{copy.headline}</BrandHeadline>
        </h1>
        <p className="max-w-[36ch] text-[15px] leading-snug text-muted-foreground">
          {copy.lede}
        </p>

        <div className="mt-6 flex flex-col gap-2.5">
          {copy.snippets.map((s, i) => (
            <div
              key={i}
              className="flex items-center gap-2.5 rounded-2xl border border-border bg-background px-3.5 py-3 font-mono text-xs"
            >
              <span className="font-sans text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {s.label}
              </span>
              <span className="truncate">{s.body}</span>
            </div>
          ))}
        </div>

        <div className="mt-auto flex gap-4 pt-6 font-mono text-xs text-muted-foreground">
          <span>v0.4.2 · auto-detected</span>
          <span>workeros.dev/docs/auth</span>
        </div>
      </div>

      {/* Right: form panel */}
      <div className="relative flex items-center justify-center p-6 md:p-10">
        <div className="relative w-full max-w-[380px]">
          <button
            type="button"
            onClick={() => setTheme(dark ? "light" : "dark")}
            aria-label="Toggle theme"
            title="Toggle theme"
            className="absolute -top-7 right-0 grid size-7 place-items-center rounded-md text-muted-foreground hover:text-foreground"
          >
            {dark ? <SunIcon size={14} /> : <MoonIcon size={14} />}
          </button>
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
                {link.label}
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
