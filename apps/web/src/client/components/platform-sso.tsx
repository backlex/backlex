import { useState } from "react";
import { ShieldIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@backlex/ui/components/button";
import { Input } from "@backlex/ui/components/input";
import { Label } from "@backlex/ui/components/label";
import { useAuthSurface, type PublicProvider } from "@/lib/auth";
import { notifyError } from "@/lib/error";

interface PlatformSsoProps {
  /** Where to land after a successful LDAP sign-in / SAML round-trip. */
  callbackURL?: string;
}

/** SAML providers (full-page redirect to the IdP) + an LDAP username/password
 *  form for the control-plane sign-in. Rendered only when the auth surface
 *  advertises platform SSO providers. */
export const PlatformSso = ({ callbackURL = "/" }: PlatformSsoProps) => {
  const { t } = useLingui();
  const { surface } = useAuthSurface();
  const [busy, setBusy] = useState(false);
  const [showLdap, setShowLdap] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const providers = surface?.providers ?? [];
  const saml: PublicProvider[] = providers.filter((p) => p.kind === "saml" && p.enabled);
  const hasLdap = providers.some((p) => p.kind === "ldap" && p.enabled);
  if (saml.length === 0 && !hasLdap) return null;

  const ldapSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setBusy(true);
    try {
      const res = await fetch("/api/auth/ldap/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        notifyError(body?.error?.message ?? t`LDAP sign-in failed`);
        return;
      }
      // The response set the session cookie; land on the dashboard.
      window.location.href = callbackURL;
    } catch (err) {
      notifyError(err, t`LDAP sign-in`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {saml.map((p) => (
        <Button
          key={p.id}
          type="button"
          variant="outline"
          className="h-10 w-full"
          onClick={() => {
            if (p.loginUrl) {
              const u = new URL(p.loginUrl);
              u.searchParams.set("relayState", new URL(callbackURL, window.location.origin).toString());
              window.location.href = u.toString();
            }
          }}
        >
          <ShieldIcon size={14} />
          <Trans>Continue with {p.label}</Trans>
        </Button>
      ))}

      {hasLdap &&
        (showLdap ? (
          <form className="space-y-2 rounded-md border border-border p-3" onSubmit={ldapSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="ldap-username">
                <Trans>LDAP username</Trans>
              </Label>
              <Input
                id="ldap-username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ldap-password">
                <Trans>LDAP password</Trans>
              </Label>
              <Input
                id="ldap-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9"
              />
            </div>
            <Button type="submit" variant="outline" className="h-9 w-full" disabled={busy}>
              {busy ? <Trans>Signing in…</Trans> : <Trans>Sign in with LDAP</Trans>}
            </Button>
          </form>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full"
            onClick={() => setShowLdap(true)}
          >
            <ShieldIcon size={14} />
            <Trans>Sign in with LDAP / AD</Trans>
          </Button>
        ))}
    </div>
  );
};

/** True if the auth surface advertises any enabled SAML/LDAP provider. */
export const useHasPlatformSso = (): boolean => {
  const { surface } = useAuthSurface();
  return (surface?.providers ?? []).some(
    (p) => (p.kind === "saml" || p.kind === "ldap") && p.enabled,
  );
};
