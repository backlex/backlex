// Integrations page — connect Slack/Discord/Datadog/GitHub; data events fan out
// to them via the shared @backlex/integrations adapters. Secrets are encrypted
// at rest and shown masked.
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { Badge, Button, PageHeader } from "../ui";
import { api } from "@/lib/api";
import { Input } from "@backlex/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { fetchSafely } from "./_shared";

type Field = { key: string; label: string; placeholder?: string; secret?: boolean };
type Catalog = { kinds: string[]; fields: Record<string, Field[]> };
type Integration = { id: string; kind: string; status: string; config: Record<string, unknown>; events: string[] | null };

const LABELS: Record<string, string> = { slack: "Slack", discord: "Discord", datadog: "Datadog", github: "GitHub" };
const BLURB: Record<string, string> = {
  slack: "Post data events to a Slack channel.",
  discord: "Post data events to a Discord channel.",
  datadog: "Forward data events to the Datadog events API.",
  github: "Fire a repository_dispatch on data events.",
};

export function IntegrationsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [catalog, setCatalog] = useState<Catalog>({ kinds: [], fields: {} });
  const [connected, setConnected] = useState<Integration[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dialog, setDialog] = useState<{ kind: string; values: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    const [cat, list] = await Promise.all([
      fetchSafely<{ data: Catalog }>("/api/admin/integrations/catalog"),
      fetchSafely<{ data: Integration[] }>("/api/admin/integrations"),
    ]);
    if (cat) setCatalog(cat.data);
    if (list) setConnected(list.data);
    setLoaded(true);
  };
  useEffect(() => {
    void reload();
  }, []);

  const byKind = new Map(connected.map((i) => [i.kind, i]));

  const openConnect = (kind: string) => {
    const values: Record<string, string> = {};
    for (const f of catalog.fields[kind] ?? []) values[f.key] = "";
    setDialog({ kind, values });
  };

  const save = async () => {
    if (!dialog) return;
    setBusy(true);
    try {
      const config: Record<string, string> = {};
      for (const [k, v] of Object.entries(dialog.values)) if (v.trim()) config[k] = v.trim();
      await api("/api/admin/integrations", {
        method: "POST",
        body: JSON.stringify({ kind: dialog.kind, config }),
      });
      pushToast(t`${LABELS[dialog.kind] ?? dialog.kind} connected.`);
      setDialog(null);
      await reload();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (it: Integration) => {
    if (!window.confirm(t`Disconnect ${LABELS[it.kind] ?? it.kind}?`)) return;
    try {
      await api(`/api/admin/integrations/${it.id}`, { method: "DELETE" });
      pushToast(t`${LABELS[it.kind] ?? it.kind} disconnected.`);
      await reload();
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  return (
    <div className="px-8 max-md:px-5 py-8 max-w-[1100px]">
      <PageHeader
        title={t`Integrations`}
        description={t`Fan record events out to Slack, Discord, Datadog, or GitHub. Secrets are encrypted at rest.`}
      />

      {!loaded ? (
        <div className="text-[13px] text-muted-foreground">
          <Trans>Loading…</Trans>
        </div>
      ) : (
        <div className="grid grid-cols-3 max-md:grid-cols-1 gap-3">
          {catalog.kinds.map((kind) => {
            const it = byKind.get(kind);
            return (
              <div key={kind} className="rounded-xl border border-border bg-card p-5 flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <span className="w-9 h-9 rounded-md grid place-items-center bg-muted">
                    <I.Plug className="size-4" />
                  </span>
                  <span className="font-medium text-[14px]">{LABELS[kind] ?? kind}</span>
                  {it && (
                    <Badge variant="default" className="ml-auto text-[10px]">
                      <Trans>Connected</Trans>
                    </Badge>
                  )}
                </div>
                <p className="text-[12px] text-muted-foreground flex-1">{BLURB[kind] ?? ""}</p>
                {it ? (
                  <Button variant="ghost" onClick={() => disconnect(it)}>
                    <Trans>Disconnect</Trans>
                  </Button>
                ) : (
                  <Button onClick={() => openConnect(kind)}>
                    <Trans>Connect</Trans>
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`Connect ${dialog ? (LABELS[dialog.kind] ?? dialog.kind) : ""}`}</DialogTitle>
            <DialogDescription>
              <Trans>Credentials are encrypted at rest and never shown again.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            {dialog &&
              (catalog.fields[dialog.kind] ?? []).map((f) => (
                <label key={f.key} className="flex flex-col gap-1 text-[12px]">
                  <span className="font-medium">{f.label}</span>
                  <Input
                    type={f.secret ? "password" : "text"}
                    placeholder={f.placeholder}
                    value={dialog.values[f.key] ?? ""}
                    onChange={(e) =>
                      setDialog((d) => (d ? { ...d, values: { ...d.values, [f.key]: e.target.value } } : d))
                    }
                  />
                </label>
              ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button onClick={save} disabled={busy}>
              {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
