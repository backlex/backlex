import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "@backlex/ui/components/button";
import { useIsMobile } from "@backlex/ui/hooks/use-mobile";
import type {
  AuthBranding,
  AuthMode,
  AuthShellCopy,
  AuthSurfaceFlags,
  LinkComponent,
} from "../types";

/**
 * "Cosmos" auth shell: a single centred glass card floating on a fixed star
 * canvas + drifting nebula blobs. The card carries a Saturn brand lockup, the
 * per-screen form (children), the mode-switch footer links, and the version
 * line.
 *
 * Lingui- and router-free: the consumer passes a `Link` component and a `copy`
 * object with the per-mode headline + lede already resolved.
 *
 * The CSS (star/nebula/glass/keyframes + cosmos token overrides for the nested
 * @backlex/ui primitives) lives in `@backlex/auth-ui/auth-shell.css`; import it
 * once at app bootstrap.
 */
export interface AuthShellProps {
  mode: AuthMode;
  branding: AuthBranding;
  copy: AuthShellCopy;
  /** Surface flags from `/api/auth/providers` — drives "claim instance" link. */
  surface?: AuthSurfaceFlags | null;
  /** App version printed at the bottom of the card. Optional. */
  appVersion?: string;
  /** Router-agnostic Link component (e.g. React Router's `<Link to=…>`). */
  Link: LinkComponent;
  /** Optional theme toggle slot (icon button). When omitted, no toggle renders. */
  themeToggle?: ReactNode;
  children: ReactNode;
}

interface FooterLink {
  mode: AuthMode;
  to: string;
  label: string;
}

/**
 * Fixed twinkling star field (spec §8). Ported from the vanilla-JS design
 * script into a React effect: a `<canvas>` sized to the viewport draws
 * ~(w·h/6500) stars — violet `#cdbcff` for the deep ones, white otherwise —
 * that slowly drift downward, twinkle, and occasionally streak as a shooting
 * star. Honours `prefers-reduced-motion` (draws one static frame, no rAF) and
 * tears the loop + listeners down on unmount.
 */
const StarCanvas = () => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Static frame (no rAF) when reduced motion is requested *or* we're on a
    // phone — a per-frame full-viewport repaint is the most expensive thing on
    // the auth screen and it costs real battery on mobile.
    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce), (max-width: 767px)")
        .matches;

    const dpr = Math.min(
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      2,
    );

    type Star = {
      x: number;
      y: number;
      r: number;
      base: number;
      tw: number;
      tws: number;
      vy: number;
      violet: boolean;
    };
    type Shooter = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      len: number;
      life: number;
      max: number;
    };

    let w = 0;
    let h = 0;
    let stars: Star[] = [];
    const shooters: Shooter[] = [];
    let raf = 0;

    const build = () => {
      w = canvas.clientWidth || window.innerWidth;
      h = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round((w * h) / 6500);
      stars = Array.from({ length: count }, () => {
        const deep = Math.random() < 0.25;
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          r: Math.random() * (deep ? 1.5 : 1.0) + 0.3,
          base: Math.random() * 0.45 + 0.35,
          tw: Math.random() * Math.PI * 2,
          tws: Math.random() * 0.018 + 0.004,
          vy: Math.random() * 0.05 + 0.015,
          violet: deep,
        };
      });
    };

    const paintStars = (animate: boolean) => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) {
        let a = s.base;
        if (animate) {
          s.tw += s.tws;
          a = s.base + Math.sin(s.tw) * 0.35;
          s.y += s.vy;
          if (s.y > h) {
            s.y = 0;
            s.x = Math.random() * w;
          }
        }
        ctx.globalAlpha = Math.max(0, Math.min(1, a));
        ctx.fillStyle = s.violet ? "#cdbcff" : "#ffffff";
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const spawnShooter = () => {
      const fromLeft = Math.random() < 0.5;
      const speed = Math.random() * 4 + 6;
      shooters.push({
        x: fromLeft ? -40 : w + 40,
        y: Math.random() * h * 0.5,
        vx: fromLeft ? speed : -speed,
        vy: speed * 0.45,
        len: Math.random() * 80 + 60,
        life: 0,
        max: Math.random() * 40 + 40,
      });
    };

    const paintShooters = () => {
      for (let i = shooters.length - 1; i >= 0; i--) {
        const sh = shooters[i];
        if (!sh) continue;
        sh.x += sh.vx;
        sh.y += sh.vy;
        sh.life += 1;
        const nx = sh.x - (sh.vx / Math.hypot(sh.vx, sh.vy)) * sh.len;
        const ny = sh.y - (sh.vy / Math.hypot(sh.vx, sh.vy)) * sh.len;
        const grad = ctx.createLinearGradient(sh.x, sh.y, nx, ny);
        const fade = 1 - sh.life / sh.max;
        grad.addColorStop(0, `rgba(255,226,212,${Math.max(0, fade)})`);
        grad.addColorStop(1, "rgba(255,226,212,0)");
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(sh.x, sh.y);
        ctx.lineTo(nx, ny);
        ctx.stroke();
        if (sh.life >= sh.max || sh.x < -80 || sh.x > w + 80 || sh.y > h + 80) {
          shooters.splice(i, 1);
        }
      }
    };

    const loop = () => {
      paintStars(true);
      if (Math.random() < 0.004 && shooters.length < 2) spawnShooter();
      paintShooters();
      raf = requestAnimationFrame(loop);
    };

    build();
    if (reduce) {
      paintStars(false);
    } else {
      raf = requestAnimationFrame(loop);
    }

    const onResize = () => {
      build();
      if (reduce) paintStars(false);
    };
    window.addEventListener("resize", onResize);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // Decorative starfield: an empty canvas exposes no accessible content.
  return <canvas ref={ref} className="cosmos-stars" tabIndex={-1} />;
};

/** Saturn: violet planet, tilted coral ring with front/back occlusion, moon. */
const SaturnMark = ({ size = 34 }: { size?: number }) => {
  const uid = useId().replace(/:/g, "");
  // SMIL <animateMotion> can't be stopped from CSS, so the orbiting moon is
  // dropped from the tree on phones — it runs forever behind the auth card.
  const isMobile = useIsMobile();
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className="cosmos-saturn"
      style={{ display: "block", overflow: "visible", flex: "0 0 auto" }}
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={`bp-${uid}`} cx="36%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#e9e1ff" />
          <stop offset="55%" stopColor="#7c5cff" />
          <stop offset="100%" stopColor="#3a2384" />
        </radialGradient>
        <clipPath id={`bf-${uid}`}>
          <rect x="0" y="16" width="32" height="16" />
        </clipPath>
      </defs>
      <g transform="rotate(-22 16 16)">
        <ellipse cx="16" cy="16" rx="14.2" ry="5.3" stroke="#ff9d83" strokeOpacity="0.85" strokeWidth="1.7" />
      </g>
      <circle cx="16" cy="16" r="7.3" fill={`url(#bp-${uid})`} />
      <g transform="rotate(-22 16 16)" clipPath={`url(#bf-${uid})`}>
        <ellipse cx="16" cy="16" rx="14.2" ry="5.3" stroke="#ffb59e" strokeWidth="1.7" />
      </g>
      <g transform="rotate(-22 16 16)">
        {isMobile ? (
          <circle cx="1.8" cy="16" r="1.5" fill="#ffe2d4" />
        ) : (
          <circle r="1.5" fill="#ffe2d4">
            <animateMotion dur="6s" repeatCount="indefinite" path="M 1.8 16 a 14.2 5.3 0 1 0 28.4 0 a 14.2 5.3 0 1 0 -28.4 0" />
          </circle>
        )}
      </g>
    </svg>
  );
};

export const AuthShell = ({
  mode,
  branding,
  copy,
  surface,
  appVersion,
  Link,
  themeToggle,
  children,
}: AuthShellProps) => {
  const brandName = branding.name?.trim() || "backlex";
  const brandLogo = branding.logoUrl ?? null;

  // Sign-in screen can have its headline/tagline overridden by admin branding.
  const headline: ReactNode =
    mode === "sign-in" && branding.signInHeadline?.trim()
      ? branding.signInHeadline
      : copy.headline;
  const lede: ReactNode =
    mode === "sign-in" && branding.signInTagline?.trim()
      ? branding.signInTagline
      : copy.lede;

  // The "Claim instance" link only exists when the server confirms zero users.
  const allLinks: FooterLink[] = [
    { mode: "sign-in", to: "/sign-in", label: copy.signInLabel },
    { mode: "sign-up", to: "/sign-up", label: copy.signUpLabel },
    { mode: "magic", to: "/magic-link", label: copy.magicLinkLabel },
    { mode: "claim", to: "/sign-up?claim=1", label: copy.claimInstanceLabel },
  ];
  const visibleLinks = allLinks.filter(
    (l) => l.mode !== "claim" || surface?.firstUserMode === true,
  );

  return (
    <div className="cosmos-auth">
      <StarCanvas />
      <div className="cosmos-neb cosmos-neb-a" aria-hidden="true" />
      <div className="cosmos-neb cosmos-neb-b" aria-hidden="true" />
      <div className="cosmos-neb cosmos-neb-c" aria-hidden="true" />

      <div className="cosmos-stage">
        {themeToggle && (
          <div className="cosmos-theme-toggle">{themeToggle}</div>
        )}

        <div className="cosmos-card">
          <div className="cosmos-brand">
            {brandLogo ? (
              <img src={brandLogo} alt="" className="cosmos-brand-logo" />
            ) : (
              <SaturnMark size={34} />
            )}
            <span className="cosmos-wordmark">{brandName}</span>
          </div>

          {(headline || lede) && (
            <div className="cosmos-intro">
              {headline && (
                <p className="cosmos-headline">
                  <BrandHeadline>{headline}</BrandHeadline>
                </p>
              )}
              {lede && <p className="cosmos-lede">{lede}</p>}
            </div>
          )}

          {children}

          {visibleLinks.length > 0 && (
            <div className="cosmos-switch">
              {visibleLinks.map((link) => (
                <Link
                  key={link.mode}
                  to={link.to}
                  className={mode === link.mode ? "is-active" : undefined}
                >
                  {link.label}
                </Link>
              ))}
            </div>
          )}

          {appVersion && <div className="cosmos-version">v{appVersion}</div>}
        </div>
      </div>
    </div>
  );
};

/**
 * Renders the headline so `<em>` becomes the violet brand highlight. The
 * design reserves italic for this emphasis only (CSS resets it to normal).
 */
const BrandHeadline = ({ children }: { children: ReactNode }) => (
  <span>{children}</span>
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
  <div className="space-y-1.5">
    <h2>{title}</h2>
    {description && (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {description}
      </p>
    )}
  </div>
);

/** Horizontal "or with email" divider. */
export const AuthDivider = ({ children }: { children: ReactNode }) => (
  <div className="cosmos-divider flex items-center gap-2.5 text-[11px] uppercase">
    <span className="h-px flex-1 bg-white/10" />
    {children}
    <span className="h-px flex-1 bg-white/10" />
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
  <div className="flex items-start gap-2.5 rounded-surface border border-primary/35 bg-primary/10 px-3.5 py-3 text-[12.5px] leading-relaxed">
    {icon && <span className="mt-0.5 shrink-0 text-primary">{icon}</span>}
    <div>{children}</div>
  </div>
);

export const AuthError = ({ children }: { children: ReactNode }) => (
  <div className="flex items-center gap-2 rounded-surface border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
    {children}
  </div>
);

/** Mode footer link rendered inside individual cards. */
export const AuthFootLink = ({
  to,
  prefix,
  label,
  Link,
}: {
  to: string;
  prefix: string;
  label: string;
  Link: LinkComponent;
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

/** Tall, full-width violet-gradient primary action used by every auth form. */
export const AuthSubmit = ({
  children,
  className,
  ...rest
}: React.ComponentProps<typeof Button>) => (
  <Button
    {...rest}
    className={`cosmos-cta w-full justify-center ${className ?? ""}`}
    size="lg"
  >
    {children}
  </Button>
);

/** Tall, full-width ghost alt action (magic link / passkey / second CTA). */
export const AuthOutline = ({
  children,
  className,
  ...rest
}: React.ComponentProps<typeof Button>) => (
  <Button
    {...rest}
    variant="outline"
    className={`cosmos-ghost w-full justify-center ${className ?? ""}`}
    size="lg"
  >
    {children}
  </Button>
);
