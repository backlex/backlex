import { useState, type ReactNode } from "react";
import { KeyRoundIcon } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@backlex/ui/components/button";
import { auth, useAuthSurface, type PublicProvider } from "@/lib/auth";
import { notifyError } from "@/lib/error";

interface SocialButtonsProps {
  /** Path to redirect to after the round-trip back from the provider. */
  callbackURL?: string;
}

const GitHubIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

const GoogleIcon = () => (
  <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.79 2.73v2.27h2.9c1.7-1.56 2.69-3.86 2.69-6.64z"
    />
    <path
      fill="#34A853"
      d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.27c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.34A8.997 8.997 0 0 0 9 18z"
    />
    <path
      fill="#FBBC05"
      d="M3.95 10.7c-.18-.54-.28-1.12-.28-1.7 0-.59.1-1.16.28-1.7V4.96H.96A9.014 9.014 0 0 0 0 9c0 1.45.35 2.83.96 4.04l2.99-2.34z"
    />
    <path
      fill="#EA4335"
      d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A8.997 8.997 0 0 0 .96 4.96L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z"
    />
  </svg>
);

// Apple's mark — monochrome, follows currentColor so it inverts cleanly in
// dark mode. Standard Sign in with Apple silhouette.
const AppleIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M11.182.008C11.148-.03 9.923.023 8.857 1.18 7.79 2.337 7.953 3.66 7.977 3.694c.024.034 1.523.106 2.443-1.218.92-1.324.764-2.43.762-2.468zM15.99 11.776c-.048-.096-2.343-1.244-2.13-3.453.213-2.21 1.687-2.815 1.71-2.879.024-.064-.604-.799-1.27-1.171a3.7 3.7 0 0 0-1.715-.46c-.12-.002-.535-.105-1.387.13-.56.155-1.834.658-2.185.678-.352.02-1.398-.585-2.523-.745-.717-.143-1.476.135-2.02.353-.542.215-1.575.834-2.297 2.476-.722 1.642-.345 4.245-.074 5.054.27.808.69 2.133 1.4 3.107.633.964 1.469 1.633 1.819 1.889.35.255 1.339.426 2.022.078.55-.336 1.541-.532 1.932-.518.39.014 1.158.174 1.943.591.62.301 1.206.176 1.792-.062.586-.238 1.428-1.137 2.41-2.969.372-.852.539-1.31.45-1.554.024-.064.604-.799-.044-.844z" />
  </svg>
);

const ICON_FOR: Record<string, () => ReactNode> = {
  github: GitHubIcon,
  google: GoogleIcon,
  apple: AppleIcon,
};

const iconFor = (id: string): ReactNode => {
  const Icon = ICON_FOR[id];
  return Icon ? <Icon /> : <KeyRoundIcon size={14} />;
};

/**
 * Renders one button per *enabled and configured* social provider returned
 * by `/api/auth/providers`. If the worker has no socials wired up (or the
 * surface fetch fails) nothing renders — no empty grid, no stranded divider.
 *
 * Calls better-auth's `signIn.social` which redirects to the provider; on a
 * successful round-trip the user lands on `callbackURL`.
 */
export const SocialButtons = ({ callbackURL = "/" }: SocialButtonsProps) => {
  const { t } = useLingui();
  const { surface } = useAuthSurface();
  const [busy, setBusy] = useState<string | null>(null);

  const socials: PublicProvider[] = (surface?.providers ?? []).filter(
    (p) => p.kind === "social" && p.enabled,
  );
  if (socials.length === 0) return null;

  const onClick = async (provider: string) => {
    setBusy(provider);
    try {
      const c = auth as unknown as {
        signIn: {
          social?: (opts: {
            provider: string;
            callbackURL?: string;
          }) => Promise<{ error?: { message?: string } }>;
        };
      };
      const fn = c.signIn.social;
      if (!fn) {
        notifyError(t`Social sign-in plugin not enabled`);
        setBusy(null);
        return;
      }
      const res = await fn({ provider, callbackURL });
      if (res?.error) {
        notifyError(res.error.message ?? t`${provider} sign-in failed`);
      }
    } catch (e) {
      notifyError(e, t`${provider} sign-in`);
    } finally {
      setBusy(null);
    }
  };

  // Two columns when even, single column when odd (one provider stretches
  // the row instead of leaving a stranded gap).
  const cols = socials.length > 1 ? "grid-cols-2" : "grid-cols-1";

  return (
    <div className={`grid gap-2 ${cols}`}>
      {socials.map((p) => (
        <Button
          key={p.id}
          type="button"
          variant="outline"
          onClick={() => onClick(p.id)}
          disabled={busy !== null}
          className="h-10"
        >
          {busy === p.id ? (
            <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            iconFor(p.id)
          )}
          {p.label}
        </Button>
      ))}
    </div>
  );
};

/** True if at least one social provider is enabled — lets sign-in / sign-up
 *  pages hide the "or with email" divider when there are no buttons above. */
export const useHasSocialProviders = (): boolean => {
  const { surface } = useAuthSurface();
  return (surface?.providers ?? []).some(
    (p) => p.kind === "social" && p.enabled,
  );
};
