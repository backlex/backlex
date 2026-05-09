import { useState } from "react";
import { auth } from "@/lib/auth";
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

/**
 * GitHub + Google OAuth buttons. Calls better-auth's `signIn.social` which
 * redirects to the provider; on a successful round-trip the user lands on
 * `callbackURL`. If the corresponding OAUTH_*_CLIENT_ID/SECRET pair isn't
 * set on the server the call returns a clear "provider disabled" error.
 */
export const SocialButtons = ({ callbackURL = "/" }: SocialButtonsProps) => {
  const [busy, setBusy] = useState<"github" | "google" | null>(null);

  const onClick = async (provider: "github" | "google") => {
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
        notifyError("Social sign-in plugin not enabled");
        setBusy(null);
        return;
      }
      const res = await fn({ provider, callbackURL });
      if (res?.error) {
        notifyError(res.error.message ?? `${provider} sign-in failed`);
      }
    } catch (e) {
      notifyError(e, `${provider} sign-in`);
    } finally {
      setBusy(null);
    }
  };

  const Btn = ({
    provider,
    icon,
    label,
  }: {
    provider: "github" | "google";
    icon: React.ReactNode;
    label: string;
  }) => (
    <button
      type="button"
      onClick={() => onClick(provider)}
      disabled={busy !== null}
      className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-3xl border border-border bg-card text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
    >
      {busy === provider ? (
        <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        icon
      )}
      {label}
    </button>
  );

  return (
    <div className="grid grid-cols-2 gap-2">
      <Btn provider="github" icon={<GitHubIcon />} label="GitHub" />
      <Btn provider="google" icon={<GoogleIcon />} label="Google" />
    </div>
  );
};
