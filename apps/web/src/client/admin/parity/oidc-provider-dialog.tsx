/**
 * Generic OIDC / OAuth2 provider create-edit dialog — the twin of
 * `saml-provider-dialog.tsx`, for the app-plane providers stored in
 * `oidc_providers` and fed to better-auth's `genericOAuth` plugin.
 *
 * Three things this form has to get right:
 *
 *  1. **Discovery.** Almost every IdP publishes
 *     `.well-known/openid-configuration`; "Fetch endpoints" resolves it through
 *     `POST /api/admin/oidc/discover` (the server applies the https-only + SSRF
 *     guards) and fills authorize / token / userinfo. Failures are shown inline
 *     with the API's own message — "Discovery URL responded 404" is far more
 *     actionable than a generic "could not fetch".
 *  2. **Write-only client secret.** The API returns `hasClientSecret: boolean`
 *     and never the value, so in edit mode the field starts blank and a blank
 *     field is OMITTED from the PATCH. Sending `clientSecret: ""` would look
 *     like an intentional clear.
 *  3. **Submission is handed to the parent** (`onSave`) rather than awaited
 *     here, so the list can apply the change optimistically and roll back on
 *     error instead of blocking the dialog on a round-trip.
 */
import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { I } from "../icons";
import { Badge, Button, Switch } from "../ui";
import { Select } from "../select";
import { oidcAdminApi, type ApiOidcProvider, type OidcProviderCreate } from "../api";
import { apiOrigin, copyText } from "./_shared";

export interface OidcProviderDialogProps {
  /** Non-null puts the dialog in edit mode for this provider. */
  existing: ApiOidcProvider | null;
  /** Tenant slug, used to synthesise the redirect URI the IdP needs. */
  workspaceSlug: string;
  onClose: () => void;
  /** Fire-and-forget — the parent applies the change optimistically. */
  onSave: (body: OidcProviderCreate, existing: ApiOidcProvider | null) => void;
  pushToast?: (msg: string) => void;
}

const DEFAULT_SCOPES = "openid profile email";

/** Claim names that actually show up in the wild, so the admin picks instead of
 *  guessing at spelling. Open-ended because the backend accepts any string —
 *  hence the "Custom…" escape hatch. */
const EMAIL_CLAIMS = ["email", "preferred_username", "upn", "mail"];
const GROUPS_CLAIMS = ["groups", "roles", "realm_access.roles", "memberOf"];
const CUSTOM = "__custom__";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

const isHttpsUrl = (s: string) => {
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
};

export function OidcProviderDialog({
  existing,
  workspaceSlug,
  onClose,
  onSave,
  pushToast,
}: OidcProviderDialogProps) {
  const { t } = useLingui();
  const isEdit = !!existing;

  const [name, setName] = useState(existing?.name ?? "");
  const [slug, setSlug] = useState(existing?.slug ?? "");
  const [clientId, setClientId] = useState(existing?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [discoveryUrl, setDiscoveryUrl] = useState(existing?.discoveryUrl ?? "");
  const [authorizationUrl, setAuthorizationUrl] = useState(existing?.authorizationUrl ?? "");
  const [tokenUrl, setTokenUrl] = useState(existing?.tokenUrl ?? "");
  const [userInfoUrl, setUserInfoUrl] = useState(existing?.userInfoUrl ?? "");

  // Advanced.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [scopes, setScopes] = useState(
    existing?.scopes?.length ? existing.scopes.join(" ") : DEFAULT_SCOPES,
  );
  const [pkce, setPkce] = useState(existing?.pkce ?? true);
  const [emailClaim, setEmailClaim] = useState(existing?.emailClaim ?? "");
  const [emailClaimCustom, setEmailClaimCustom] = useState(
    !!existing?.emailClaim && !EMAIL_CLAIMS.includes(existing.emailClaim),
  );
  const [groupsClaim, setGroupsClaim] = useState(existing?.groupsClaim ?? "");
  const [groupsClaimCustom, setGroupsClaimCustom] = useState(
    !!existing?.groupsClaim && !GROUPS_CLAIMS.includes(existing.groupsClaim),
  );
  const [linkByVerifiedEmail, setLinkByVerifiedEmail] = useState(
    existing?.linkByVerifiedEmail ?? false,
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);

  // Discovery.
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoveredScopes, setDiscoveredScopes] = useState<string[] | null>(null);

  const effectiveSlug = slug.trim() || slugify(name);
  const base = apiOrigin().replace(/\/+$/, "");
  const redirectUri = `${base}/api/t/${workspaceSlug || "<workspace>"}/auth/oauth2/callback/${
    effectiveSlug || "<slug>"
  }`;

  const runDiscovery = async () => {
    const url = discoveryUrl.trim();
    if (!url) return;
    setDiscovering(true);
    setDiscoverError(null);
    try {
      const res = await oidcAdminApi.discover(url);
      const d = res.data ?? {};
      if (d.authorizationUrl) setAuthorizationUrl(d.authorizationUrl);
      if (d.tokenUrl) setTokenUrl(d.tokenUrl);
      if (d.userInfoUrl) setUserInfoUrl(d.userInfoUrl);
      setDiscoveredScopes(d.scopesSupported ?? null);
      pushToast?.(t`Endpoints fetched.`);
    } catch (e) {
      // Surface the API's own message — it distinguishes "must use https" from
      // "responded 404" from "missing authorization_endpoint".
      setDiscoverError((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  };

  const endpointsOk =
    !!discoveryUrl.trim() || (!!authorizationUrl.trim() && !!tokenUrl.trim());
  const secretOk = isEdit ? true : !!clientSecret.trim();
  const valid =
    name.trim().length >= 1 &&
    effectiveSlug.length >= 2 &&
    clientId.trim().length >= 1 &&
    secretOk &&
    endpointsOk;

  const submit = () => {
    if (!valid) return;
    const body: OidcProviderCreate = {
      name: name.trim(),
      slug: effectiveSlug,
      clientId: clientId.trim(),
      discoveryUrl: discoveryUrl.trim() || null,
      authorizationUrl: authorizationUrl.trim() || null,
      tokenUrl: tokenUrl.trim() || null,
      userInfoUrl: userInfoUrl.trim() || null,
      scopes: scopes.trim() ? scopes.trim().split(/[\s,]+/).filter(Boolean) : undefined,
      pkce,
      emailClaim: emailClaim.trim() || null,
      groupsClaim: groupsClaim.trim() || null,
      linkByVerifiedEmail,
      enabled,
    };
    // Write-only credential: a blank field in edit mode means "keep the stored
    // secret", so it must not travel at all.
    if (clientSecret.trim()) body.clientSecret = clientSecret.trim();
    onSave(body, existing);
  };

  const labelCls = "flex items-center gap-2 text-[12.5px] font-medium text-foreground";
  const hintCls = "text-[11.5px] text-muted-foreground";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(88vh,760px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <DialogHeader className="shrink-0 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
            {isEdit ? <Trans>Configure OIDC provider</Trans> : <Trans>Add OIDC provider</Trans>}
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            <Trans>OpenID Connect / OAuth2 sign-in for this workspace's end-users.</Trans>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea viewportClassName="max-h-[calc(min(88vh,760px)-10rem)] max-[640px]:max-h-[calc(min(88vh,760px)-15rem)]">
          <div className="flex flex-col gap-4 px-5 py-[18px]">
            <div className="flex flex-col gap-1.5">
              <label className={labelCls} htmlFor="oidc-name"><Trans>Display name</Trans></label>
              <Input
                id="oidc-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t`Acme Okta`}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={labelCls} htmlFor="oidc-slug"><Trans>Slug</Trans></label>
              <Input
                id="oidc-slug"
                className="font-mono"
                value={slug || (name ? effectiveSlug : "")}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="okta"
              />
              <span className={hintCls}>
                <Trans>Lowercase id used in the sign-in call and the redirect URI below.</Trans>
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={labelCls} htmlFor="oidc-client-id"><Trans>Client ID</Trans></label>
              <Input
                id="oidc-client-id"
                className="font-mono"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="0oa1b2c3d4EfGhIjK5d7"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={labelCls} htmlFor="oidc-client-secret">
                <Trans>Client secret</Trans>
                {existing?.hasClientSecret && (
                  <Badge variant="secondary"><Trans>stored</Trans></Badge>
                )}
              </label>
              <Input
                id="oidc-client-secret"
                type="password"
                className="font-mono"
                autoComplete="new-password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={
                  existing?.hasClientSecret
                    ? t`leave blank to keep the current secret`
                    : t`paste from the provider`
                }
              />
              <span className={hintCls}>
                {existing?.hasClientSecret ? (
                  <Trans>A secret is stored and cannot be read back. Leave this blank to keep the current secret.</Trans>
                ) : (
                  <Trans>Encrypted at rest; it is never returned by the API.</Trans>
                )}
              </span>
            </div>

            <div className="flex flex-col gap-1.5 border-t border-border pt-4">
              <label className={labelCls} htmlFor="oidc-discovery"><Trans>Discovery URL</Trans></label>
              <Input
                id="oidc-discovery"
                className="font-mono"
                value={discoveryUrl}
                onChange={(e) => { setDiscoveryUrl(e.target.value); setDiscoverError(null); }}
                placeholder="https://issuer.example.com/.well-known/openid-configuration"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  icon={I.Download}
                  disabled={discovering || !discoveryUrl.trim()}
                  onClick={() => void runDiscovery()}
                >
                  {discovering ? <Trans>Fetching…</Trans> : <Trans>Fetch endpoints</Trans>}
                </Button>
                <span className={hintCls}>
                  <Trans>Issuer origin works too — the well-known path is appended.</Trans>
                </span>
              </div>
              {discoverError && (
                <span role="alert" className="text-[11.5px] text-destructive">
                  {discoverError}
                </span>
              )}
              {!discoverError && !!discoveryUrl.trim() && !isHttpsUrl(discoveryUrl.trim()) && (
                <span className="text-[11.5px] text-destructive">
                  <Trans>Must be an https URL.</Trans>
                </span>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={labelCls} htmlFor="oidc-authorize"><Trans>Authorization URL</Trans></label>
              <Input
                id="oidc-authorize"
                className="font-mono"
                value={authorizationUrl}
                onChange={(e) => setAuthorizationUrl(e.target.value)}
                placeholder="https://issuer.example.com/oauth2/v1/authorize"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className={labelCls} htmlFor="oidc-token"><Trans>Token URL</Trans></label>
              <Input
                id="oidc-token"
                className="font-mono"
                value={tokenUrl}
                onChange={(e) => setTokenUrl(e.target.value)}
                placeholder="https://issuer.example.com/oauth2/v1/token"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className={labelCls} htmlFor="oidc-userinfo">
                <Trans>UserInfo URL</Trans>
                <span className="text-muted-foreground"><Trans>optional</Trans></span>
              </label>
              <Input
                id="oidc-userinfo"
                className="font-mono"
                value={userInfoUrl}
                onChange={(e) => setUserInfoUrl(e.target.value)}
                placeholder="https://issuer.example.com/oauth2/v1/userinfo"
              />
            </div>
            {!endpointsOk && (
              <span className="text-[11.5px] text-destructive">
                <Trans>Set a discovery URL, or both the authorization and token URLs.</Trans>
              </span>
            )}

            <div className="border-t border-border pt-4">
              <Button
                size="sm"
                variant="ghost"
                icon={showAdvanced ? I.ChevronDown : I.ChevronRight}
                aria-expanded={showAdvanced}
                onClick={() => setShowAdvanced((v) => !v)}
              >
                <Trans>Advanced</Trans>
              </Button>
            </div>

            {showAdvanced && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className={labelCls} htmlFor="oidc-scopes"><Trans>Scopes</Trans></label>
                  <Input
                    id="oidc-scopes"
                    className="font-mono"
                    value={scopes}
                    onChange={(e) => setScopes(e.target.value)}
                    placeholder={DEFAULT_SCOPES}
                  />
                  <span className={hintCls}>
                    {discoveredScopes?.length ? (
                      <Trans>Space-separated. Advertised by the IdP: {discoveredScopes.join(", ")}</Trans>
                    ) : (
                      <Trans>Space-separated. Defaults to openid profile email.</Trans>
                    )}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className={labelCls}><Trans>Email claim</Trans></label>
                  <Select
                    value={emailClaimCustom ? CUSTOM : emailClaim}
                    onChange={(v) => {
                      if (v === CUSTOM) { setEmailClaimCustom(true); return; }
                      setEmailClaimCustom(false);
                      setEmailClaim(v);
                    }}
                    options={[
                      { value: "", label: t`— default (email) —` },
                      ...EMAIL_CLAIMS.map((c) => ({ value: c, label: c })),
                      { value: CUSTOM, label: t`Custom…` },
                    ]}
                  />
                  {emailClaimCustom && (
                    <Input
                      className="font-mono"
                      value={emailClaim}
                      onChange={(e) => setEmailClaim(e.target.value)}
                      placeholder="custom_email_claim"
                      aria-label={t`Custom email claim`}
                    />
                  )}
                  <span className={hintCls}>
                    <Trans>Which ID-token claim carries the user's email address.</Trans>
                  </span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className={labelCls}><Trans>Groups claim</Trans></label>
                  <Select
                    value={groupsClaimCustom ? CUSTOM : groupsClaim}
                    onChange={(v) => {
                      if (v === CUSTOM) { setGroupsClaimCustom(true); return; }
                      setGroupsClaimCustom(false);
                      setGroupsClaim(v);
                    }}
                    options={[
                      { value: "", label: t`— none —` },
                      ...GROUPS_CLAIMS.map((c) => ({ value: c, label: c })),
                      { value: CUSTOM, label: t`Custom…` },
                    ]}
                  />
                  {groupsClaimCustom && (
                    <Input
                      className="font-mono"
                      value={groupsClaim}
                      onChange={(e) => setGroupsClaim(e.target.value)}
                      placeholder="custom_groups_claim"
                      aria-label={t`Custom groups claim`}
                    />
                  )}
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className={labelCls}><Trans>PKCE</Trans></div>
                    <div className={hintCls}>
                      <Trans>Send a code challenge on the authorize request. Leave on unless the IdP rejects it.</Trans>
                    </div>
                  </div>
                  <Switch checked={pkce} onChange={setPkce} />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className={labelCls}><Trans>Link by verified email</Trans></div>
                    <div className={hintCls}>
                      <Trans>Risk: a hostile IdP can take over any local account that shares an email. Off by default.</Trans>
                    </div>
                  </div>
                  <Switch checked={linkByVerifiedEmail} onChange={setLinkByVerifiedEmail} />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className={labelCls}><Trans>Enabled</Trans></div>
                    <div className={hintCls}>
                      <Trans>Off keeps the provider configured but hidden from sign-in.</Trans>
                    </div>
                  </div>
                  <Switch checked={enabled} onChange={setEnabled} />
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5 border-t border-border pt-4">
              <span className={labelCls}>
                <Trans>Redirect URI</Trans>
                <span className="text-muted-foreground"><Trans>register this with the IdP</Trans></span>
              </span>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
                  {redirectUri}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void copyText(redirectUri, () => pushToast?.(t`Copied.`))}
                >
                  <Trans>Copy</Trans>
                </Button>
              </div>
            </div>
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0 items-center border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3 sm:justify-start">
          <span className="text-xs text-muted-foreground">
            {valid
              ? isEdit ? <Trans>Ready to save.</Trans> : <Trans>Ready to create.</Trans>
              : <Trans>Fill the required fields.</Trans>}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button
            variant="primary"
            size="sm"
            icon={isEdit ? I.Check : I.Plus}
            disabled={!valid}
            onClick={submit}
          >
            {isEdit ? <Trans>Save</Trans> : <Trans>Add provider</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
