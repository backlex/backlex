import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { AlertTriangleIcon, PlugZapIcon, CheckIcon, EyeIcon, PencilIcon, UserIcon, RefreshCwIcon } from "lucide-react";
import {
  AuthShell,
  AuthCard,
  AuthCardHeader,
  AuthCallout,
  AuthSubmit,
  AuthOutline,
  type AuthBranding,
  type AuthShellCopy,
} from "@backlex/auth-ui";
import { api, ApiError } from "@/lib/api";
import { notifyError } from "@/lib/error";
import { useWorkspaceBranding } from "@/lib/branding";
import { version as appVersion } from "../../../package.json";

/**
 * OAuth consent screen for the MCP authorization flow (better-auth `mcp`
 * plugin). The authorize endpoint redirects here with `?consent_code=…&
 * client_id=…&scope=…` once the user is signed in; accepting POSTs the code
 * back to `/api/auth/oauth2/consent`, which answers with the client's
 * redirect URI (carrying the authorization code) for us to navigate to.
 * Hosted Claude (claude.ai custom connectors) is the primary client.
 */
export const OAuthConsent = () => {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const wsBranding = useWorkspaceBranding();
  const consentCode = params.get("consent_code") ?? "";
  const clientId = params.get("client_id") ?? "";
  const scopes = useMemo(
    () => (params.get("scope") ?? "").split(" ").filter(Boolean),
    [params],
  );
  const [busy, setBusy] = useState<"accept" | "deny" | null>(null);

  // Human explanations for the scopes the consent screen can encounter.
  // Unknown scopes render verbatim so nothing is silently hidden.
  const SCOPE_INFO: Record<string, { icon: React.ReactNode; label: string }> = {
    openid: { icon: <UserIcon size={14} />, label: t`Know who you are` },
    profile: { icon: <UserIcon size={14} />, label: t`Read your basic profile` },
    email: { icon: <UserIcon size={14} />, label: t`See your email address` },
    offline_access: {
      icon: <RefreshCwIcon size={14} />,
      label: t`Stay connected without re-approving`,
    },
    "mcp:read": {
      icon: <EyeIcon size={14} />,
      label: t`Run read-only MCP tools (query collections, schema, search)`,
    },
    "mcp:write": {
      icon: <PencilIcon size={14} />,
      label: t`Run write MCP tools (create, update, delete — your permissions still apply)`,
    },
  };

  const decide = async (accept: boolean) => {
    setBusy(accept ? "accept" : "deny");
    try {
      const res = await api<{ redirectURI?: string }>("/api/auth/oauth2/consent", {
        method: "POST",
        body: JSON.stringify({ accept, consent_code: consentCode || null }),
      });
      if (res.redirectURI) {
        window.location.href = res.redirectURI;
        return;
      }
      notifyError(t`The authorization flow returned no redirect — start over from the client.`);
      setBusy(null);
    } catch (err) {
      setBusy(null);
      if (err instanceof ApiError && err.status === 401) {
        notifyError(t`Your session expired — sign in and retry from the client.`);
        return;
      }
      notifyError(err);
    }
  };

  const branding: AuthBranding = {
    name: wsBranding?.workspaceName?.trim() || "backlex",
    logoUrl: wsBranding?.logoUrl ?? null,
  };
  const shellCopy: AuthShellCopy = {
    headline: <Trans>Connect an <em>agent</em>.</Trans>,
    lede: <Trans>An MCP client is asking to access this workspace on your behalf.</Trans>,
    signInLabel: t`Sign in`,
    signUpLabel: t`Sign up`,
    magicLinkLabel: t`Magic link`,
    claimInstanceLabel: t`Claim instance`,
    toggleTheme: t`Toggle theme`,
  };

  const invalid = !consentCode;

  return (
    <AuthShell
      mode="sign-in"
      branding={branding}
      copy={shellCopy}
      appVersion={appVersion}
      Link={({ to, className, children }) => (
        <Link to={to} className={className}>
          {children}
        </Link>
      )}
    >
      <AuthCard>
        {invalid ? (
          <>
            <AuthCardHeader
              title={<Trans>Authorization request not found</Trans>}
              description={<Trans>This consent link is missing its code or has expired.</Trans>}
            />
            <AuthCallout icon={<AlertTriangleIcon size={16} />}>
              <Trans>Start the connection again from your MCP client (for example claude.ai → Connectors).</Trans>
            </AuthCallout>
          </>
        ) : (
          <>
            <AuthCardHeader
              title={<Trans>Authorize MCP access</Trans>}
              description={
                <Trans>
                  The client below wants to call this workspace's MCP tools as you.
                  Your roles and permission rules still gate every call.
                </Trans>
              }
            />
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
              <PlugZapIcon size={15} className="shrink-0 text-primary" />
              <span className="truncate font-mono text-[12px]" title={clientId}>
                {clientId || t`unknown client`}
              </span>
            </div>
            {scopes.length > 0 && (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {scopes.map((s) => (
                  <li key={s} className="flex items-start gap-2 text-[13px]">
                    <span className="mt-0.5 shrink-0 text-muted-foreground">
                      {SCOPE_INFO[s]?.icon ?? <CheckIcon size={14} />}
                    </span>
                    <span>
                      {SCOPE_INFO[s]?.label ?? <span className="font-mono">{s}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <AuthSubmit
              type="button"
              disabled={busy !== null}
              onClick={() => void decide(true)}
            >
              {busy === "accept" ? <Trans>Authorizing…</Trans> : <Trans>Authorize</Trans>}
            </AuthSubmit>
            <AuthOutline
              type="button"
              disabled={busy !== null}
              onClick={() => void decide(false)}
            >
              {busy === "deny" ? <Trans>Denying…</Trans> : <Trans>Deny</Trans>}
            </AuthOutline>
          </>
        )}
      </AuthCard>
    </AuthShell>
  );
};
