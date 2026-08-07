// SCIM provisioning card — sits under the SSO blocks in auth-settings.
//
// The whole card exists around one awkward fact: the bearer token is shown
// EXACTLY once. It is stored as a SHA-256 hash, so there is no read-back path
// and a lost token must be rotated. That shapes the UI: the token appears in a
// dismissable panel with a copy button and an explicit warning, and everything
// else in the card only ever sees `tokenPrefix`.
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, Switch, relativeTime } from "../../ui";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { Select } from "../../select";
import { scimAdminApi, type ApiScimConfig } from "../../api";
import { fetchSafely } from "../_shared";

export function ScimCard({
  availableRoles,
  pushToast,
}: {
  availableRoles: { id: string; name: string }[];
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [config, setConfig] = useState<ApiScimConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Plaintext token, held only until the admin dismisses it. Never persisted. */
  const [freshToken, setFreshToken] = useState<{ token: string; baseUrl: string } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      // A `scim_config` table that predates the migration reads as "not set up".
      const res = await fetchSafely<{ data: ApiScimConfig | null }>("/api/admin/scim");
      if (!live) return;
      setConfig(res?.data ?? null);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  const issue = async () => {
    setBusy(true);
    try {
      const res = await scimAdminApi.issueToken(
        config?.defaultRoleId != null ? { defaultRoleId: config.defaultRoleId } : {},
      );
      setConfig(res.data);
      setFreshToken({ token: res.token, baseUrl: res.baseUrl });
      pushToast(config ? t`SCIM token rotated.` : t`SCIM provisioning enabled.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Optimistic: the switch and the role picker flip immediately, then reconcile.
  const patch = async (body: { enabled?: boolean; defaultRoleId?: string | null }) => {
    if (!config) return;
    const snapshot = config;
    setConfig({ ...config, ...body });
    try {
      const res = await scimAdminApi.update(body);
      setConfig(res.data);
    } catch (e) {
      setConfig(snapshot);
      pushToast((e as Error).message);
    }
  };

  const remove = async () => {
    const snapshot = config;
    setConfig(null);
    setFreshToken(null);
    try {
      await scimAdminApi.remove();
      pushToast(t`SCIM provisioning removed.`);
    } catch (e) {
      setConfig(snapshot);
      pushToast((e as Error).message);
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast(t`${label} copied.`);
    } catch {
      pushToast(t`Could not copy — select the text manually.`);
    }
  };

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <I.Users size={13} />
        <span className="text-[13px] font-medium">
          <Trans>SCIM provisioning</Trans>
        </span>
        {loaded && config && (
          <Badge variant={config.enabled ? "default" : "destructive"}>
            {config.enabled ? t`active` : t`disabled`}
          </Badge>
        )}
        <div className="flex-1" />
        {loaded && (
          <Button size="sm" variant="outline" icon={I.Key} disabled={busy} onClick={() => void issue()}>
            {busy ? (
              <Trans>Working…</Trans>
            ) : config ? (
              <Trans>Rotate token</Trans>
            ) : (
              <Trans>Enable SCIM</Trans>
            )}
          </Button>
        )}
      </div>

      {!loaded ? (
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : !config ? (
        <div className="px-4 py-3.5 text-[12.5px] text-muted-foreground">
          <Trans>
            Let your identity provider create, update and — the part SSO alone cannot do —
            deactivate this workspace's end-users on its own schedule. Enable it to get a base URL
            and a bearer token for Okta, Entra ID or OneLogin.
          </Trans>
        </div>
      ) : (
        <>
          {freshToken && (
            <div className="border-b border-border bg-muted/40 px-4 py-3.5">
              <div className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-foreground">
                <I.Key size={13} />
                <Trans>Copy these into your IdP now</Trans>
              </div>
              <p className="mb-2.5 text-[11.5px] text-destructive">
                <Trans>
                  The token is shown only once — it is stored hashed and cannot be recovered. If you
                  lose it, rotate for a new one.
                </Trans>
              </p>
              <TokenRow
                label={t`Base URL`}
                value={freshToken.baseUrl}
                onCopy={() => void copy(freshToken.baseUrl, t`Base URL`)}
              />
              <TokenRow
                label={t`Bearer token`}
                value={freshToken.token}
                onCopy={() => void copy(freshToken.token, t`Token`)}
              />
              <Button size="sm" variant="ghost" onClick={() => setFreshToken(null)}>
                <Trans>I've saved it</Trans>
              </Button>
            </div>
          )}

          <div className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px]">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">
                <Trans>Enabled</Trans>
              </div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Disabling refuses every SCIM request without discarding the token.</Trans>
              </div>
            </div>
            <Switch checked={config.enabled} onChange={(v) => void patch({ enabled: v })} />
          </div>

          <div className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px]">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">
                <Trans>Default role</Trans>
              </div>
              <div className="text-[11.5px] text-muted-foreground">
                <Trans>Granted to every provisioned user, on top of pushed group membership.</Trans>
              </div>
            </div>
            <Select
              className="min-w-0"
              value={config.defaultRoleId ?? ""}
              onChange={(v) => void patch({ defaultRoleId: v || null })}
              options={[
                { value: "", label: t`(none)` },
                ...availableRoles.map((r) => ({ value: r.id, label: r.name })),
              ]}
            />
          </div>

          <div className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px]">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">
                <Trans>Token</Trans>
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {config.tokenPrefix}…
              </div>
            </div>
            <div className="text-right text-[11.5px] text-muted-foreground">
              {config.lastRequestAt ? (
                <Trans>last sync {relativeTime(config.lastRequestAt)}</Trans>
              ) : (
                // The single most useful diagnostic: the IdP has never called.
                <Trans>never used</Trans>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end px-3.5 py-[11px]">
            <Button size="sm" variant="ghost" onClick={() => void remove()}>
              <Trans>Remove SCIM</Trans>
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/** One copyable value. The input is read-only rather than plain text so the
 *  admin can still select it if the clipboard API is unavailable. */
function TokenRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    // Stacks on a phone: a fixed-width label left only ~156px for a 69-char
    // token, so the value was almost entirely scrolled out of view. The label
    // moves above the field below `sm`, giving the input the full row.
    <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
      <span className="text-[11.5px] text-muted-foreground sm:w-24 sm:shrink-0">{label}</span>
      <div className="flex min-w-0 items-center gap-2 sm:contents">
      <input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 rounded-control border border-border bg-background px-2 py-1 font-mono text-[11px]"
      />
      <Button size="sm" variant="outline" onClick={onCopy}>
        <Trans>Copy</Trans>
      </Button>
      </div>
    </div>
  );
}
