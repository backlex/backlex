// OAuth clients — who this instance's authorization server has let in.
//
// The card leads with the clients that let THEMSELVES in. Dynamic registration
// is on by default because the hosted MCP connectors need it, which means the
// list is the only place anybody ever sees them — so "self-registered" is a
// badge rather than a detail, and the switch that closes registration is
// reported next to it.
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, Switch } from "../../ui";
import { Input } from "@backlex/ui/components/input";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { oauthClientsApi, type ApiOAuthClient } from "../../api";
import { fetchSafely } from "../_shared";

export function OAuthClientsCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ApiOAuthClient[]>([]);
  const [dynamicOn, setDynamicOn] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ clientId: string; secret: string } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetchSafely<{ data: ApiOAuthClient[]; dynamicRegistration: boolean }>(
        "/api/admin/oauth-clients",
      );
      if (!live) return;
      setRows(res?.data ?? []);
      setDynamicOn(res?.dynamicRegistration ?? true);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Optimistic: snapshot → apply → reconcile → roll back on error.
  const toggle = async (row: ApiOAuthClient, enabled: boolean) => {
    const snapshot = rows;
    setRows(rows.map((r) => (r.clientId === row.clientId ? { ...r, disabled: !enabled } : r)));
    try {
      await oauthClientsApi.setDisabled(row.clientId, !enabled);
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  const remove = async (row: ApiOAuthClient) => {
    const snapshot = rows;
    setRows(rows.filter((r) => r.clientId !== row.clientId));
    try {
      await oauthClientsApi.remove(row.clientId);
      pushToast(t`Client deleted — its tokens and consents went with it.`);
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  const create = async (input: { name: string; redirect: string; confidential: boolean }) => {
    setCreating(false);
    try {
      const res = await oauthClientsApi.register({
        name: input.name,
        redirectUrls: input.redirect.split(/[\s,]+/).filter(Boolean),
        type: input.confidential ? "confidential" : "public",
      });
      setRows((prev) => [res.data, ...prev]);
      if (res.clientSecret) {
        setIssued({ clientId: res.data.clientId, secret: res.clientSecret });
      } else {
        pushToast(t`Client registered. A public client has no secret — PKCE protects it.`);
      }
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <I.Key size={13} />
        <span className="text-[13px] font-medium">
          <Trans>OAuth clients</Trans>
        </span>
        {!dynamicOn && (
          <Badge variant="default">
            <Trans>registration closed</Trans>
          </Badge>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="outline" icon={I.Plus} onClick={() => setCreating(true)}>
          <Trans>Register</Trans>
        </Button>
      </div>

      <div className="border-b border-border px-4 py-3 text-[12.5px] text-muted-foreground">
        {dynamicOn ? (
          <Trans>
            Applications that can sign a person in through this instance. Open registration is on,
            so a client can introduce itself — those are marked, because nobody vetted them. Set
            OAUTH_DYNAMIC_REGISTRATION=off to make this list the only way in.
          </Trans>
        ) : (
          <Trans>
            Applications that can sign a person in through this instance. Open registration is
            closed, so this list is the only way a client gets in.
          </Trans>
        )}
      </div>

      {issued && (
        <div className="border-b border-border px-4 py-3">
          <div className="mb-1.5 text-[12px] font-medium">
            <Trans>Copy the client secret now — it is not shown again</Trans>
          </div>
          <div className="flex flex-col gap-1 font-mono text-[11.5px]">
            <div className="break-all">{issued.clientId}</div>
            <div className="break-all">{issued.secret}</div>
          </div>
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
              <Trans>Done</Trans>
            </Button>
          </div>
        </div>
      )}

      {!loaded ? (
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6">
          <EmptyState
            bare
            size="sm"
            icon={I.Key}
            title={<Trans>No OAuth clients</Trans>}
            description={
              <Trans>
                Register one to let an application sign people in through this instance.
              </Trans>
            }
          />
        </div>
      ) : (
        rows.map((row) => (
          <div key={row.clientId} className="border-b border-border px-3.5 py-3 last:border-b-0">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
              <div className="min-w-0 sm:flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{row.name}</span>
                  <Badge variant="outline">{row.type}</Badge>
                  {row.dynamic && (
                    <Badge variant="destructive">
                      <Trans>self-registered</Trans>
                    </Badge>
                  )}
                  {row.activeTokens > 0 && (
                    <Badge variant="default">{t`${row.activeTokens} tokens`}</Badge>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {row.clientId}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {row.redirectUrls.join(" ")}
                </div>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => void remove(row)}>
                  <Trans>Delete</Trans>
                </Button>
                <Switch checked={!row.disabled} onChange={(v) => void toggle(row, v)} />
              </div>
            </div>
          </div>
        ))
      )}

      {creating && (
        <RegisterDialog onClose={() => setCreating(false)} onSave={(v) => void create(v)} />
      )}
    </Card>
  );
}

function RegisterDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (v: { name: string; redirect: string; confidential: boolean }) => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [redirect, setRedirect] = useState("");
  const [confidential, setConfidential] = useState(false);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[520px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            <Trans>Register an OAuth client</Trans>
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>
              Redirect URIs must be https, or http on loopback for a native app — the
              authorization code is delivered to them.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">{t`Name`}</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Reporting portal"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">{t`Redirect URIs`}</span>
              <Input
                className="font-mono"
                value={redirect}
                onChange={(e) => setRedirect(e.target.value)}
                placeholder="https://portal.example.com/callback"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                <Trans>Separate several with a space.</Trans>
              </span>
            </label>
            <label className="flex items-start gap-2.5">
              <Switch checked={confidential} onChange={setConfidential} />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium">
                  <Trans>Confidential client</Trans>
                </span>
                <span className="block text-[11.5px] text-muted-foreground">
                  <Trans>
                    Only for a client that runs on a server. A browser app or a CLI is public:
                    PKCE protects it, and a secret shipped to a user is not a secret.
                  </Trans>
                </span>
              </span>
            </label>
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={!name.trim() || !redirect.trim()}
            onClick={() =>
              onSave({ name: name.trim(), redirect: redirect.trim(), confidential })
            }
          >
            <Trans>Register</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
