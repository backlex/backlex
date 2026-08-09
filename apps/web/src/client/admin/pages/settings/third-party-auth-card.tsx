/**
 * Trusted third-party issuers — the card under the SSO blocks in auth-settings.
 *
 * The distinction this UI has to teach in one glance: the SAML and OIDC cards
 * above configure *sign-in flows* (backlex sends the user to an IdP and mints
 * its own session). This card configures *token trust* — the app already holds
 * a Clerk / Auth0 / Firebase / Cognito / WorkOS token and sends it straight to
 * the API. Nobody migrates a user table, and there is no second login.
 *
 * Two choices worth keeping:
 *
 *  1. **Vendor presets, not a blank issuer box.** Getting `iss` wrong by a
 *     trailing slash is the single most common setup failure and it presents as
 *     a silent 401. The preset fills the shape (`https://<x>.clerk.accounts.dev`)
 *     and the discovery URL, so the admin only supplies their own subdomain.
 *  2. **A test box on every saved row.** Pasting a real token and being told
 *     which claim mapping matched turns "my token is rejected" from a support
 *     ticket into a ten-second answer.
 */
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import {
  type ApiThirdPartyAuthProvider,
  type ThirdPartyAuthProviderCreate,
  type ThirdPartyAuthTestResult,
  thirdPartyAuthApi,
} from "../../api";
import { I } from "../../icons";
import { Select } from "../../select";
import type { PushToast } from "../../types";
import { Badge, Button, Switch } from "../../ui";
import { fetchSafely } from "../_shared";

const CUSTOM = "__custom__";

/** Claim names that actually appear in these vendors' tokens. Open-ended,
 *  because the backend accepts any string — hence "Custom…". */
const SUBJECT_CLAIMS = ["sub", "user_id", "uid"];
const EMAIL_CLAIMS = ["email", "email_address", "preferred_username", "upn"];
const GROUPS_CLAIMS = ["groups", "roles", "org_role", "cognito:groups", "permissions"];

interface Preset {
  id: string;
  label: string;
  /** `{}` marks the part the admin replaces. */
  issuerHint: string;
  discoveryHint: string;
  emailClaim: string;
  groupsClaim?: string;
  note: string;
}

const PRESETS: Preset[] = [
  {
    id: "clerk",
    label: "Clerk",
    issuerHint: "https://{your-subdomain}.clerk.accounts.dev",
    discoveryHint: "https://{your-subdomain}.clerk.accounts.dev/.well-known/openid-configuration",
    emailClaim: "email",
    groupsClaim: "org_role",
    note: "Clerk's issuer is your Frontend API host, without a trailing slash.",
  },
  {
    id: "auth0",
    label: "Auth0",
    issuerHint: "https://{your-tenant}.auth0.com/",
    discoveryHint: "https://{your-tenant}.auth0.com/.well-known/openid-configuration",
    emailClaim: "email",
    note: "Auth0's issuer ends with a slash. Copy it exactly from the token, not from the dashboard URL.",
  },
  {
    id: "firebase",
    label: "Firebase Auth",
    issuerHint: "https://securetoken.google.com/{project-id}",
    discoveryHint:
      "https://securetoken.google.com/{project-id}/.well-known/openid-configuration",
    emailClaim: "email",
    note: "Firebase signs with keys that carry no `alg`; backlex treats those as RS256.",
  },
  {
    id: "cognito",
    label: "AWS Cognito",
    issuerHint: "https://cognito-idp.{region}.amazonaws.com/{pool-id}",
    discoveryHint:
      "https://cognito-idp.{region}.amazonaws.com/{pool-id}/.well-known/openid-configuration",
    emailClaim: "email",
    groupsClaim: "cognito:groups",
    note: "Use the ID token, not the access token — only the ID token carries `email`.",
  },
  {
    id: "workos",
    label: "WorkOS",
    issuerHint: "https://api.workos.com/user_management/{client-id}",
    discoveryHint:
      "https://api.workos.com/sso/oidc/{client-id}/.well-known/openid-configuration",
    emailClaim: "email",
    note: "",
  },
  { id: "custom", label: "Custom / other", issuerHint: "", discoveryHint: "", emailClaim: "email", note: "" },
];

const labelCls =
  "flex items-center gap-2 text-[12.5px] font-medium text-foreground";

export function ThirdPartyAuthCard({
  availableRoles,
  pushToast,
}: {
  availableRoles: { id: string; name: string }[];
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ApiThirdPartyAuthProvider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState<
    { mode: "create" } | { mode: "edit"; row: ApiThirdPartyAuthProvider } | null
  >(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetchSafely<{ data: ApiThirdPartyAuthProvider[] }>(
        "/api/admin/third-party-auth/providers",
      );
      if (!live) return;
      setRows(res?.data ?? []);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Optimistic: the switch flips now, the request reconciles after.
  const toggle = async (row: ApiThirdPartyAuthProvider, enabled: boolean) => {
    const snapshot = rows;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled } : r)));
    try {
      const res = await thirdPartyAuthApi.update(row.id, { enabled });
      setRows((prev) => prev.map((r) => (r.id === row.id ? res.data : r)));
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  const remove = async (id: string) => {
    const snapshot = rows;
    setConfirmRemove(null);
    setRows((prev) => prev.filter((r) => r.id !== id));
    try {
      await thirdPartyAuthApi.remove(id);
      pushToast(t`Issuer removed.`);
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  const save = async (
    body: ThirdPartyAuthProviderCreate,
    existing: ApiThirdPartyAuthProvider | null,
  ) => {
    const snapshot = rows;
    setDialog(null);
    if (existing) {
      setRows((prev) =>
        prev.map((r) => (r.id === existing.id ? { ...r, ...body } : r)),
      );
    }
    try {
      const res = existing
        ? await thirdPartyAuthApi.update(existing.id, body)
        : await thirdPartyAuthApi.create(body);
      setRows((prev) =>
        existing
          ? prev.map((r) => (r.id === existing.id ? res.data : r))
          : [...prev, res.data],
      );
      pushToast(existing ? t`Issuer updated.` : t`Issuer trusted.`);
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  return (
    <>
      <Card className="gap-0 py-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.Key size={13} />
          <span className="text-[13px] font-medium">
            <Trans>Third-party auth</Trans>
          </span>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {rows.length} {rows.length === 1 ? t`issuer` : t`issuers`}
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="outline"
            icon={I.Plus}
            className="ml-auto"
            onClick={() => setDialog({ mode: "create" })}
          >
            <Trans>Trust issuer</Trans>
          </Button>
        </div>

        {!loaded && (
          <div className="flex flex-col gap-2 px-4 py-3.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}

        {loaded && rows.length === 0 && (
          <div className="border-b border-border px-4 py-3.5 text-[12.5px] text-muted-foreground last:border-b-0">
            <Trans>
              No trusted issuers. Add one to let an app that already signs users
              in with Clerk, Auth0, Firebase, Cognito or WorkOS call this API
              with the token it already has — no user migration, no second login.
            </Trans>
          </div>
        )}

        {rows.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3.5 py-3 text-[13px] last:border-b-0 md:grid md:grid-cols-[24px_1fr_auto_auto_auto_auto] md:gap-3 md:py-[11px]"
          >
            <span className="shrink-0">
              <I.Key size={13} />
            </span>
            {/* `w-full` until md: on a wrapping flex row the identity block has
                to claim the whole first line, or the four controls beside it
                squeeze it to a few characters per line — `flex-1` alone does
                not stop that, it only distributes what is left. */}
            <div className="w-full min-w-0 md:w-auto md:flex-1">
              <div className="text-[13px] font-medium">{p.name}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {p.issuer}
              </div>
              {!p.audience && (
                <div className="text-[11px] text-muted-foreground">
                  <Trans>Any audience accepted</Trans>
                </div>
              )}
            </div>
            <Badge variant="default">JWT</Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDialog({ mode: "edit", row: p })}
            >
              <Trans>Configure</Trans>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(p.id)}>
              <Trans>Delete</Trans>
            </Button>
            <Switch checked={p.enabled} onChange={(v) => void toggle(p, v)} />
          </div>
        ))}
      </Card>

      {dialog && (
        <ThirdPartyAuthDialog
          existing={dialog.mode === "edit" ? dialog.row : null}
          availableRoles={availableRoles}
          onClose={() => setDialog(null)}
          onSave={save}
          pushToast={pushToast}
        />
      )}

      <Dialog open={confirmRemove !== null} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
              <Trans>Stop trusting this issuer?</Trans>
            </DialogTitle>
            <DialogDescription className="text-[12.5px]">
              <Trans>
                Every app authenticating with its tokens stops being recognised
                immediately. The people already linked keep their accounts, so
                re-adding the same issuer restores access rather than creating
                duplicates.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => confirmRemove && void remove(confirmRemove)}
            >
              <Trans>Delete</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ThirdPartyAuthDialog({
  existing,
  availableRoles,
  onClose,
  onSave,
  pushToast,
}: {
  existing: ApiThirdPartyAuthProvider | null;
  availableRoles: { id: string; name: string }[];
  onClose: () => void;
  onSave: (
    body: ThirdPartyAuthProviderCreate,
    existing: ApiThirdPartyAuthProvider | null,
  ) => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  // The preset the create form opens on. Its values have to seed the initial
  // state, not just fire on change — otherwise an admin who accepts the default
  // provider gets an empty issuer box and the preset does nothing at all.
  const initial = existing ? null : PRESETS[0]!;
  const [preset, setPreset] = useState(existing ? "custom" : initial!.id);
  const [name, setName] = useState(existing?.name ?? initial?.label ?? "");
  const [issuer, setIssuer] = useState(existing?.issuer ?? initial?.issuerHint ?? "");
  const [discoveryUrl, setDiscoveryUrl] = useState(
    existing?.discoveryUrl ?? initial?.discoveryHint ?? "",
  );
  const [jwksUrl, setJwksUrl] = useState(existing?.jwksUrl ?? "");
  const [audience, setAudience] = useState(existing?.audience ?? "");
  const [subjectClaim, setSubjectClaim] = useState(existing?.subjectClaim ?? "sub");
  const [subjectCustom, setSubjectCustom] = useState(
    existing ? !SUBJECT_CLAIMS.includes(existing.subjectClaim) : false,
  );
  const [emailClaim, setEmailClaim] = useState(
    existing?.emailClaim ?? initial?.emailClaim ?? "email",
  );
  const [emailCustom, setEmailCustom] = useState(
    existing ? !EMAIL_CLAIMS.includes(existing.emailClaim) : false,
  );
  const [groupsClaim, setGroupsClaim] = useState(
    existing?.groupsClaim ?? initial?.groupsClaim ?? "",
  );
  const [groupsCustom, setGroupsCustom] = useState(
    existing?.groupsClaim ? !GROUPS_CLAIMS.includes(existing.groupsClaim) : false,
  );
  const [defaultRoleId, setDefaultRoleId] = useState(existing?.defaultRoleId ?? "");
  const [linkByVerifiedEmail, setLinkByVerifiedEmail] = useState(
    existing?.linkByVerifiedEmail ?? false,
  );
  const [autoProvision, setAutoProvision] = useState(existing?.autoProvision ?? true);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);

  const [testToken, setTestToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ThirdPartyAuthTestResult | null>(null);

  const chosen = PRESETS.find((p) => p.id === preset);

  const applyPreset = (id: string) => {
    setPreset(id);
    const p = PRESETS.find((x) => x.id === id);
    if (!p || p.id === "custom") return;
    // Replace another preset's label, but never something the admin typed.
    if (!name || PRESETS.some((x) => x.label === name)) setName(p.label);
    setIssuer(p.issuerHint);
    setDiscoveryUrl(p.discoveryHint);
    setEmailClaim(p.emailClaim);
    setEmailCustom(!EMAIL_CLAIMS.includes(p.emailClaim));
    if (p.groupsClaim) {
      setGroupsClaim(p.groupsClaim);
      setGroupsCustom(!GROUPS_CLAIMS.includes(p.groupsClaim));
    }
  };

  // A placeholder still carrying `{…}` means the admin has not filled it in.
  const unfilled = (v: string) => v.includes("{") && v.includes("}");
  const valid =
    name.trim().length > 0 &&
    issuer.trim().length > 0 &&
    !unfilled(issuer) &&
    (discoveryUrl.trim().length > 0 || jwksUrl.trim().length > 0) &&
    !unfilled(discoveryUrl) &&
    !unfilled(jwksUrl);

  const runTest = async () => {
    if (!existing || !testToken.trim()) return;
    setTesting(true);
    try {
      const res = await thirdPartyAuthApi.test(existing.id, testToken.trim());
      setTestResult(res.data);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  const submit = () => {
    onSave(
      {
        name: name.trim(),
        issuer: issuer.trim(),
        discoveryUrl: discoveryUrl.trim() || null,
        ...(discoveryUrl.trim() ? {} : { jwksUrl: jwksUrl.trim() }),
        audience: audience.trim() || null,
        subjectClaim: subjectClaim.trim() || "sub",
        emailClaim: emailClaim.trim() || "email",
        groupsClaim: groupsClaim.trim() || null,
        defaultRoleId: defaultRoleId || null,
        linkByVerifiedEmail,
        autoProvision,
        enabled,
      },
      existing,
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-[560px]">
        <DialogHeader className="shrink-0 border-b border-border px-5 pt-[18px] pr-12 pb-3.5 text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
            {existing ? (
              <Trans>Configure {existing.name}</Trans>
            ) : (
              <Trans>Trust a third-party issuer</Trans>
            )}
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            <Trans>
              Accept tokens minted by another identity provider as they are. This
              is not a sign-in button — the app already holds the token.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3.5 px-5 py-[18px]">
            {!existing && (
              <div className="flex flex-col gap-1.5">
                <label className={labelCls}>
                  <Trans>Provider</Trans>
                </label>
                <Select
                  value={preset}
                  onChange={applyPreset}
                  options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                />
                {chosen?.note && (
                  <span className="text-[11.5px] text-muted-foreground">{chosen.note}</span>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label className={labelCls}>
                <Trans>Display name</Trans>
              </label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={labelCls}>
                <Trans>Issuer</Trans>
              </label>
              <Input
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
                className="font-mono text-[12px]"
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>
                  Must equal the token's `iss` claim character for character —
                  including any trailing slash. Unique across this instance.
                </Trans>
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={labelCls}>
                <Trans>Discovery URL</Trans>
              </label>
              <Input
                value={discoveryUrl}
                onChange={(e) => setDiscoveryUrl(e.target.value)}
                className="font-mono text-[12px]"
                placeholder="https://…/.well-known/openid-configuration"
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>The signing-key endpoint is read from this once, at save time.</Trans>
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={labelCls}>
                <Trans>JWKS URL</Trans>
              </label>
              <Input
                value={jwksUrl}
                onChange={(e) => setJwksUrl(e.target.value)}
                className="font-mono text-[12px]"
                placeholder="https://…/.well-known/jwks.json"
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>Only needed when the issuer publishes no discovery document.</Trans>
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={labelCls}>
                <Trans>Audience</Trans>
              </label>
              <Input
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                className="font-mono text-[12px]"
                placeholder={t`— any audience —`}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>
                  Leave blank only when this issuer serves this workspace alone.
                  One IdP shared by several apps needs it set.
                </Trans>
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label className={labelCls}>
                  <Trans>Subject claim</Trans>
                </label>
                <Select
                  value={subjectCustom ? CUSTOM : subjectClaim}
                  onChange={(v) => {
                    if (v === CUSTOM) {
                      setSubjectCustom(true);
                      return;
                    }
                    setSubjectCustom(false);
                    setSubjectClaim(v);
                  }}
                  options={[
                    ...SUBJECT_CLAIMS.map((c) => ({ value: c, label: c })),
                    { value: CUSTOM, label: t`Custom…` },
                  ]}
                />
                {subjectCustom && (
                  <Input
                    value={subjectClaim}
                    onChange={(e) => setSubjectClaim(e.target.value)}
                    className="font-mono text-[12px]"
                  />
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className={labelCls}>
                  <Trans>Email claim</Trans>
                </label>
                <Select
                  value={emailCustom ? CUSTOM : emailClaim}
                  onChange={(v) => {
                    if (v === CUSTOM) {
                      setEmailCustom(true);
                      return;
                    }
                    setEmailCustom(false);
                    setEmailClaim(v);
                  }}
                  options={[
                    ...EMAIL_CLAIMS.map((c) => ({ value: c, label: c })),
                    { value: CUSTOM, label: t`Custom…` },
                  ]}
                />
                {emailCustom && (
                  <Input
                    value={emailClaim}
                    onChange={(e) => setEmailClaim(e.target.value)}
                    className="font-mono text-[12px]"
                  />
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className={labelCls}>
                  <Trans>Groups claim</Trans>
                </label>
                <Select
                  value={groupsCustom ? CUSTOM : groupsClaim}
                  onChange={(v) => {
                    if (v === CUSTOM) {
                      setGroupsCustom(true);
                      return;
                    }
                    setGroupsCustom(false);
                    setGroupsClaim(v);
                  }}
                  options={[
                    { value: "", label: t`— none —` },
                    ...GROUPS_CLAIMS.map((c) => ({ value: c, label: c })),
                    { value: CUSTOM, label: t`Custom…` },
                  ]}
                />
                {groupsCustom && (
                  <Input
                    value={groupsClaim}
                    onChange={(e) => setGroupsClaim(e.target.value)}
                    className="font-mono text-[12px]"
                  />
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className={labelCls}>
                  <Trans>Default role</Trans>
                </label>
                <Select
                  value={defaultRoleId}
                  onChange={setDefaultRoleId}
                  options={[
                    { value: "", label: t`— none —` },
                    ...availableRoles.map((r) => ({ value: r.id, label: r.name })),
                  ]}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <div className="min-w-0">
                <div className={labelCls}>
                  <Trans>Create accounts on first sight</Trans>
                </div>
                <div className="text-[11.5px] text-muted-foreground">
                  <Trans>Turn off when SCIM owns the user lifecycle — unknown subjects are then refused.</Trans>
                </div>
              </div>
              <Switch checked={autoProvision} onChange={setAutoProvision} />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <div className="min-w-0">
                <div className={labelCls}>
                  <Trans>Link by email</Trans>
                </div>
                <div className="text-[11.5px] text-muted-foreground">
                  <Trans>Attach to an existing end-user with the same address. Only safe when the issuer verifies emails.</Trans>
                </div>
              </div>
              <Switch checked={linkByVerifiedEmail} onChange={setLinkByVerifiedEmail} />
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <div className="min-w-0">
                <div className={labelCls}>
                  <Trans>Enabled</Trans>
                </div>
                <div className="text-[11.5px] text-muted-foreground">
                  <Trans>Accept tokens from this issuer.</Trans>
                </div>
              </div>
              <Switch checked={enabled} onChange={setEnabled} />
            </div>

            {existing && (
              <div className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2.5">
                <div className={labelCls}>
                  <Trans>Test a token</Trans>
                </div>
                <div className="text-[11.5px] text-muted-foreground">
                  <Trans>Paste a real token from this issuer. Nothing is provisioned and no session is created.</Trans>
                </div>
                <Input
                  value={testToken}
                  onChange={(e) => setTestToken(e.target.value)}
                  className="font-mono text-[12px]"
                  placeholder="eyJhbGciOi…"
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={testing || !testToken.trim()}
                    onClick={() => void runTest()}
                  >
                    {testing ? <Trans>Checking…</Trans> : <Trans>Check token</Trans>}
                  </Button>
                  {testResult && (
                    <Badge variant={testResult.valid ? "default" : "destructive"}>
                      {testResult.valid ? t`valid` : t`rejected`}
                    </Badge>
                  )}
                </div>
                {testResult && !testResult.valid && testResult.reason && (
                  <span className="text-[11.5px] text-destructive">{testResult.reason}</span>
                )}
                {testResult?.valid && (
                  <div className="font-mono text-[11.5px] text-muted-foreground">
                    sub: {testResult.subject} · email: {testResult.email ?? "—"}
                    {testResult.groups && testResult.groups.length > 0
                      ? ` · groups: ${testResult.groups.join(", ")}`
                      : ""}
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 items-center border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3 sm:justify-start">
          <span className="text-xs text-muted-foreground">
            {valid ? (
              <Trans>Ready to save.</Trans>
            ) : (
              <Trans>Fill the required fields.</Trans>
            )}
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button size="sm" variant="primary" icon={I.Check} disabled={!valid} onClick={submit}>
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
