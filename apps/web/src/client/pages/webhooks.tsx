import { useEffect, useState, type FormEvent } from "react";
import { toast } from "@workeros/ui/components/sonner";
import { PlusIcon, Trash2Icon, WebhookIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Textarea } from "@workeros/ui/components/textarea";
import { Badge } from "@workeros/ui/components/badge";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";

interface Webhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  secret: string | null;
  active: boolean | number;
  createdAt: string;
}

export const Webhooks = () => {
  const [items, setItems] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("items:*:*");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setLoading(true);
    api<{ data: Webhook[] }>("/api/webhooks")
      .then((r) => setItems(r.data))
      .catch((e) => notifyError(e, "Loading webhooks"))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/webhooks", {
        method: "POST",
        body: JSON.stringify({
          name,
          url,
          events: events.split(/[\s,]+/).filter(Boolean),
          secret: secret || undefined,
        }),
      });
      setShowForm(false);
      setName("");
      setUrl("");
      setEvents("items:*:*");
      setSecret("");
      refresh();
    } catch (e) {
      notifyError(e, "Creating webhook");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api(`/api/webhooks/${id}`, { method: "DELETE" });
      refresh();
    } catch (e) {
      notifyError(e, "Deleting webhook");
    }
  };

  const toggle = async (w: Webhook) => {
    try {
      await api(`/api/webhooks/${w.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !w.active }),
      });
      refresh();
    } catch (e) {
      notifyError(e, "Updating webhook");
    }
  };

  return (
    <div>
      <PageHeader
        title="Webhooks"
        description="HMAC-signed POST requests fired on item events. Useful for integrations, audit pipelines, and downstream caches."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
            <Button size="sm" onClick={() => setShowForm((s) => !s)}>
              <PlusIcon /> {showForm ? "Cancel" : "New"}
            </Button>
          </>
        }
      />

      {showForm && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>New webhook</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="url">URL</Label>
                <Input
                  id="url"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/hook"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="events">Event patterns (comma-separated)</Label>
                <Textarea
                  id="events"
                  rows={2}
                  value={events}
                  onChange={(e) => setEvents(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Examples: <code>items:posts:created</code>,{" "}
                  <code>items:posts:*</code>, <code>items:*:*</code>
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="secret">HMAC secret (optional)</Label>
                <Input
                  id="secret"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="signing key"
                />
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={busy}>
                  {busy ? "Creating…" : "Create"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          {loading ? (
            <ul className="divide-y">
              {Array.from({ length: 3 }).map((_, i) => (
                <li key={i} className="flex items-start justify-between gap-4 py-3">
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-56" />
                  </div>
                  <Skeleton className="size-8 rounded-full" />
                </li>
              ))}
            </ul>
          ) : items.length === 0 ? (
            <EmptyState
              icon={WebhookIcon}
              title="No webhooks configured"
              description="Webhooks fire HMAC-signed POST requests on item events. Useful for integrations, audit pipelines, downstream caches."
              action={
                <Button size="sm" onClick={() => setShowForm(true)}>
                  <PlusIcon /> New webhook
                </Button>
              }
            />
          ) : (
            <ul className="divide-y">
              {items.map((w) => (
                <li
                  key={w.id}
                  className="flex items-start justify-between gap-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{w.name}</span>
                      <button
                        type="button"
                        onClick={() => toggle(w)}
                        className="cursor-pointer"
                        title={w.active ? "Click to pause" : "Click to activate"}
                      >
                        <Badge variant={w.active ? "default" : "secondary"}>
                          {w.active ? "active" : "paused"}
                        </Badge>
                      </button>
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {w.url}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1 text-xs">
                      {w.events.map((e) => (
                        <span key={e} className="rounded-md bg-muted px-2 py-0.5 font-mono">
                          {e}
                        </span>
                      ))}
                    </div>
                  </div>
                  <ConfirmAction
                    title="Delete this webhook?"
                    description={`"${w.name}" will stop receiving events.`}
                    actionLabel="Delete"
                    destructive
                    onConfirm={() => remove(w.id)}
                  >
                    <Button variant="ghost" size="icon-sm">
                      <Trash2Icon />
                    </Button>
                  </ConfirmAction>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {!loading && items.length > 0 && <RecentDeliveries />}
    </div>
  );
};

interface Delivery {
  id: string;
  webhookId: string;
  event: string;
  status: number;
  ms: number;
  responseBody: string | null;
  error: string | null;
  attempts: number;
  deliveredAt: string | number;
}

const RecentDeliveries = () => {
  const [items, setItems] = useState<Delivery[] | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const refresh = () => {
    api<{ data: Delivery[] }>("/api/webhooks/_deliveries?limit=50")
      .then((r) => setItems(r.data))
      .catch((e) => notifyError(e, "Loading deliveries"));
  };

  useEffect(refresh, []);

  const retry = async (id: string) => {
    setRetrying(id);
    try {
      const r = await api<{ data: { status: number; ms: number } }>(
        `/api/webhooks/_deliveries/${id}/retry`,
        { method: "POST" },
      );
      const ok = r.data.status >= 200 && r.data.status < 300;
      if (ok) toast.success(`Replayed · ${r.data.status} · ${r.data.ms}ms`);
      else notifyError(`Replayed but got ${r.data.status}`);
      refresh();
    } catch (e) {
      notifyError(e, "Retrying delivery");
    } finally {
      setRetrying(null);
    }
  };

  const fmtTs = (v: string | number): string => {
    const d = new Date(v);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleTimeString();
  };

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm">
        <WebhookIcon className="size-4" />
        <span className="font-medium">Recent deliveries</span>
        <span className="font-mono text-xs text-muted-foreground">
          last 50 · auto-recorded on dispatch
        </span>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={refresh}>
          Refresh
        </Button>
      </div>
      <CardContent className="p-0">
        {items === null ? (
          <ul className="divide-y divide-border">
            {Array.from({ length: 3 }).map((_, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-40 flex-1" />
                <Skeleton className="h-3 w-12" />
              </li>
            ))}
          </ul>
        ) : items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No deliveries yet — fire an event with{" "}
            <code className="font-mono">POST /api/items/&lt;slug&gt;</code>{" "}
            to populate this log.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((d) => {
              const ok = d.status >= 200 && d.status < 300;
              const isError = d.status === 0 || d.status >= 400;
              return (
                <li
                  key={d.id}
                  className="grid grid-cols-[88px_1fr_auto_auto_auto] items-center gap-3 px-4 py-2 text-sm"
                >
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {fmtTs(d.deliveredAt)}
                  </span>
                  <span className="truncate font-mono text-xs">{d.event}</span>
                  <Badge
                    variant={ok ? "default" : isError ? "destructive" : "secondary"}
                    className="font-mono tabular-nums"
                  >
                    {d.status === 0 ? "ERR" : d.status}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {d.ms}ms
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => retry(d.id)}
                    disabled={retrying === d.id}
                  >
                    {retrying === d.id ? "…" : "Retry"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};
