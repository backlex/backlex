import { useState } from "react";
import { Trans } from "@lingui/react/macro";
import { FlaskConicalIcon } from "lucide-react";
import { Button } from "@backlex/ui/components/button";
import { auth, useAuthSurface } from "@/lib/auth";
import { notifyError } from "@/lib/error";

/**
 * One-click "enter the playground" button for the sign-in screen. Rendered
 * only when the server publishes demo credentials on the auth surface
 * (`DEMO_MODE` instances) — signs in with the shared demo-admin account and
 * lands on `next`.
 */
export const DemoSignInButton = ({
  demo,
  next,
}: {
  demo: { email: string; password: string };
  next: string;
}) => {
  const [busy, setBusy] = useState(false);
  const enter = async () => {
    setBusy(true);
    const res = await auth.signIn.email({
      email: demo.email,
      password: demo.password,
    });
    if (res.error) {
      notifyError(res.error.message ?? "Sign-in failed");
      setBusy(false);
      return;
    }
    window.location.href = next;
  };
  return (
    <Button type="button" className="w-full" onClick={enter} disabled={busy}>
      <FlaskConicalIcon />
      {busy ? <Trans>Entering…</Trans> : <Trans>Enter the playground</Trans>}
    </Button>
  );
};

/**
 * Thin persistent strip shown at the top of the admin shell on a playground
 * instance: tells visitors the data is shared and periodically wiped.
 */
export const DemoBanner = () => {
  const { surface } = useAuthSurface();
  if (!surface?.demo) return null;
  return (
    <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-center text-[12px] text-amber-700 dark:text-amber-300">
      <FlaskConicalIcon size={13} className="shrink-0" />
      <span>
        <Trans>
          Playground — this is a shared demo. Anyone can edit the data, and
          everything resets every hour.
        </Trans>
      </span>
    </div>
  );
};
