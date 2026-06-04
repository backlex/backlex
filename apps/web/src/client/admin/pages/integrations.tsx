// Integrations page — connect Slack/Discord/Datadog/GitHub; data events fan out
// to them via the shared @backlex/integrations adapters. Secrets are encrypted
// at rest and shown masked. UI mirrors the cloud control plane: brand-marked
// cards with a last-event timestamp, and a connect dialog that also lets the
// admin scope which collection events the integration receives.
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge, Button, PageHeader, relativeTime } from "../ui";
import { useCollections } from "../queries";
import { api } from "@/lib/api";
import { Input } from "@backlex/ui/components/input";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
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
type Integration = {
  id: string;
  kind: string;
  status: string;
  config: Record<string, unknown>;
  events: string[] | null;
  lastEventAt?: number | string | null;
};

const GithubMark = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.1 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
  </svg>
);

/** Brand presentation per provider — coloured mark + label for the cards. */
type Brand = { name: string; mark: ReactNode; markBg: string };
const BRANDS: Record<string, Brand> = {
  slack: { name: "Slack", mark: "#", markBg: "oklch(0.55 0.16 320)" },
  discord: { name: "Discord", mark: "D", markBg: "oklch(0.5 0.16 270)" },
  github: { name: "GitHub", mark: <GithubMark />, markBg: "oklch(0.22 0.005 286)" },
  datadog: { name: "Datadog", mark: "DD", markBg: "oklch(0.5 0.13 280)" },
};
const brandFor = (kind: string): Brand => BRANDS[kind] ?? { name: kind, mark: kind.slice(0, 2).toUpperCase(), markBg: "oklch(0.45 0.02 286)" };

export function IntegrationsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [catalog, setCatalog] = useState<Catalog>({ kinds: [], fields: {} });
  const [connected, setConnected] = useState<Integration[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [connectKind, setConnectKind] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);

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

  // Data-plane event blurb per provider (kept inline so Lingui extracts them).
  const blurb = (kind: string): string => {
    switch (kind) {
      case "slack":
        return t`Post data events to a Slack channel.`;
      case "discord":
        return t`Post data events to a Discord channel.`;
      case "datadog":
        return t`Forward data events to the Datadog events API.`;
      case "github":
        return t`Fire a repository_dispatch on data events.`;
      default:
        return "";
    }
  };

  const connect = async (kind: string, config: Record<string, string>, events: string[]) => {
    setBusyKind(kind);
    try {
      await api("/api/admin/integrations", {
        method: "POST",
        body: JSON.stringify({ kind, config, events: events.length ? events : null }),
      });
      pushToast(t`${brandFor(kind).name} connected.`);
      setConnectKind(null);
      await reload();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusyKind(null);
    }
  };

  const disconnect = async (it: Integration) => {
    setBusyKind(it.kind);
    try {
      await api(`/api/admin/integrations/${it.id}`, { method: "DELETE" });
      pushToast(t`${brandFor(it.kind).name} disconnected.`);
      await reload();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusyKind(null);
    }
  };

  const skeletonKinds = catalog.kinds.length ? catalog.kinds : ["slack", "discord", "datadog", "github"];

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Integrations`}
        description={t`Fan record events out to Slack, Discord, Datadog, or GitHub. Secrets are encrypted at rest.`}
      />

      <div className="grid grid-cols-3 max-[920px]:grid-cols-2 max-[560px]:grid-cols-1 gap-3">
        {!loaded
          ? skeletonKinds.map((k) => (
              <div key={k} className="rounded-xl border border-border bg-card p-5 flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <Skeleton className="h-10 w-10 rounded-md" />
                  <Skeleton className="h-3.5 w-24 mt-1" />
                </div>
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-8 w-24 mt-auto" />
              </div>
            ))
          : catalog.kinds.map((kind) => {
              const brand = brandFor(kind);
              const it = byKind.get(kind);
              const isConnected = it?.status === "connected";
              const busy = busyKind === kind;
              return (
                <div key={kind} className="rounded-xl border border-border bg-card p-5 flex flex-col gap-3">
                  <div className="flex items-start gap-3">
                    <span
                      className="w-10 h-10 rounded-md grid place-items-center font-bold text-white text-[14px] shrink-0"
                      style={{ background: brand.markBg }}
                    >
                      {brand.mark}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-[14px] font-semibold">{brand.name}</h3>
                        {isConnected && (
                          <Badge variant="default" className="text-[10px]">
                            <Trans>Connected</Trans>
                          </Badge>
                        )}
                      </div>
                      {isConnected && it?.lastEventAt ? (
                        <div className="text-[11.5px] text-muted-foreground truncate">
                          <Trans>last event {relativeTime(it.lastEventAt)}</Trans>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-[12px] text-muted-foreground leading-snug flex-1">{blurb(kind)}</p>
                  <div className="mt-auto">
                    {isConnected ? (
                      <Button variant="ghost" disabled={busy} onClick={() => void disconnect(it!)}>
                        {busy ? <Trans>Disconnecting…</Trans> : <Trans>Disconnect</Trans>}
                      </Button>
                    ) : (
                      <Button disabled={busy} onClick={() => setConnectKind(kind)}>
                        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
      </div>

      {connectKind && (
        <ConnectDialog
          kind={connectKind}
          name={brandFor(connectKind).name}
          fields={catalog.fields[connectKind] ?? []}
          existing={byKind.get(connectKind) ?? null}
          busy={busyKind === connectKind}
          onClose={() => setConnectKind(null)}
          onConnect={(config, events) => void connect(connectKind, config, events)}
        />
      )}
    </div>
  );
}

/* ── Connect an integration: provider credentials + event subscriptions ── */
function ConnectDialog({
  kind,
  name,
  fields,
  existing,
  busy,
  onClose,
  onConnect,
}: {
  kind: string;
  name: string;
  fields: Field[];
  existing: Integration | null;
  busy: boolean;
  onClose: () => void;
  onConnect: (config: Record<string, string>, events: string[]) => void;
}) {
  const { t } = useLingui();
  const collectionsQuery = useCollections();
  const collections = collectionsQuery.data?.data ?? [];
  // Data-plane events are `<collection>.<action>`; a `<slug>.*` subscription
  // (matchesEventFilter prefix wildcard) covers create/update/delete for one
  // collection. No selection = all events.
  const eventOptions = collections.map((c) => `${c.slug}.*`);

  const [values, setValues] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<Set<string>>(new Set(existing?.events ?? []));
  const toggleEvent = (e: string) =>
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });

  // Required = every field whose label doesn't say "optional".
  const ready = fields.every(
    (f) => f.label.toLowerCase().includes("optional") || (values[f.key]?.trim().length ?? 0) > 0,
  );

  const submit = () => {
    const config: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (v.trim()) config[k] = v.trim();
    onConnect(config, [...events]);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[min(86vh,720px)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[520px]">
        <DialogHeader className="space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">{t`Connect ${name}`}</DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>Credentials are encrypted at rest and never shown again.</Trans>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-3.5 px-5 py-4">
            {fields.map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1 block text-[11.5px] font-medium">{f.label}</span>
                <Input
                  type={f.secret ? "password" : "text"}
                  placeholder={f.placeholder}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              </label>
            ))}

            <div>
              <span className="mb-1.5 block text-[11.5px] font-medium">
                <Trans>Events</Trans>{" "}
                <span className="font-normal text-muted-foreground">
                  · <Trans>none selected = all</Trans>
                </span>
              </span>
              {eventOptions.length === 0 ? (
                <p className="text-[11.5px] text-muted-foreground">
                  <Trans>No collections yet — events fire once you create one.</Trans>
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {eventOptions.map((e) => {
                    const on = events.has(e);
                    return (
                      <button
                        key={e}
                        type="button"
                        onClick={() => toggleEvent(e)}
                        className={`rounded-md border px-2 py-1 font-mono text-[11px] transition-colors ${
                          on
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {e}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>

        <DialogFooter className="border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={submit} disabled={busy || !ready}>
            {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
