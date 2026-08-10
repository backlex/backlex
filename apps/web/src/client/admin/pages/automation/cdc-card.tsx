// CDC sinks — a collection's changefeed, delivered somewhere.
//
// The row leads with how far the sink has got and what its last error was,
// because those are the two questions somebody opens this card to answer.
// "Run" is beside them for the same reason: a sink that looks stuck is either
// caught up or being refused, and one click distinguishes them.
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, Switch, relativeTime } from "../../ui";
import { Select } from "../../select";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
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
import { cdcApi, type ApiCdcSink } from "../../api";
import { fetchSafely } from "../_shared";

export function CdcCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ApiCdcSink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetchSafely<{ data: ApiCdcSink[] }>("/api/admin/cdc-sinks");
      if (!live) return;
      setRows(res?.data ?? []);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Optimistic: snapshot → apply → reconcile → roll back on error.
  const toggle = async (row: ApiCdcSink, enabled: boolean) => {
    const snapshot = rows;
    setRows(rows.map((r) => (r.id === row.id ? { ...r, enabled, disabledReason: null } : r)));
    try {
      const res = await cdcApi.update(row.id, { enabled });
      setRows((prev) => prev.map((r) => (r.id === row.id ? res.data : r)));
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  const remove = async (row: ApiCdcSink) => {
    const snapshot = rows;
    setRows(rows.filter((r) => r.id !== row.id));
    try {
      await cdcApi.remove(row.id);
      pushToast(t`Sink deleted — the destination keeps what it already received.`);
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  const runNow = async (row: ApiCdcSink) => {
    setRunning(row.id);
    try {
      const res = await cdcApi.run(row.id);
      pushToast(
        res.error
          ? t`Delivery failed: ${res.error}. The batch will be retried.`
          : res.delivered === 0
            ? t`Nothing to send — this sink is caught up.`
            : t`Delivered ${res.delivered} record(s).`,
      );
      const listed = await cdcApi.list();
      setRows(listed.data);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setRunning(null);
    }
  };

  const create = async (input: Record<string, unknown>) => {
    setCreating(false);
    try {
      const res = await cdcApi.create(input as never);
      setRows((prev) => [...prev, res.data]);
      pushToast(t`Sink created — it starts from the beginning of the collection.`);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <I.Zap size={13} />
        <span className="text-[13px] font-medium">
          <Trans>Change data capture</Trans>
        </span>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {rows.length} {rows.length === 1 ? t`sink` : t`sinks`}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" icon={I.Plus} onClick={() => setCreating(true)}>
          <Trans>Add sink</Trans>
        </Button>
      </div>

      <div className="border-b border-border px-4 py-3 text-[12.5px] text-muted-foreground">
        <Trans>
          Deliver a collection's changes — deletes included — to a webhook or to this workspace's
          own bucket. Delivery is at-least-once: a batch that fails is retried, and every record
          carries a stable key so the destination can deduplicate.
        </Trans>
      </div>

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
            icon={I.Zap}
            title={<Trans>No sinks</Trans>}
            description={
              <Trans>Add one to replicate a collection into a warehouse, a queue or an archive.</Trans>
            }
          />
        </div>
      ) : (
        rows.map((row) => (
          <div key={row.id} className="border-b border-border px-3.5 py-3 last:border-b-0">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
              <div className="min-w-0 sm:flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{row.name}</span>
                  <Badge variant="outline">{row.destination}</Badge>
                  {row.shape && (
                    <Badge variant="default">
                      <Trans>shaped</Trans>
                    </Badge>
                  )}
                  {!row.enabled && row.disabledReason && (
                    <Badge variant="destructive">
                      <Trans>Paused</Trans>
                    </Badge>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {row.collection} · {row.cursor ? t`caught up` : t`from the start`}
                  {row.lastRunAt ? ` · ${relativeTime(row.lastRunAt)}` : ""}
                </div>
                {row.lastError && (
                  <div className="truncate text-[11px] text-destructive">{row.lastError}</div>
                )}
                {row.enabled && row.consecutiveFailures > 0 && (
                  <div className="text-[11px] text-destructive">
                    <Trans>{row.consecutiveFailures} consecutive failures</Trans>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={running === row.id}
                  onClick={() => void runNow(row)}
                >
                  {running === row.id ? <Trans>Running…</Trans> : <Trans>Run</Trans>}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(row)}>
                  <Trans>Delete</Trans>
                </Button>
                <Switch checked={row.enabled} onChange={(v) => void toggle(row, v)} />
              </div>
            </div>
          </div>
        ))
      )}

      {creating && <SinkDialog onClose={() => setCreating(false)} onSave={(v) => void create(v)} />}
    </Card>
  );
}

function SinkDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (v: Record<string, unknown>) => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [collection, setCollection] = useState("");
  const [destination, setDestination] = useState("webhook");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [prefix, setPrefix] = useState("cdc");
  const [shape, setShape] = useState("");

  const ready =
    name.trim() && collection.trim() && (destination === "storage" || url.trim());

  const submit = () =>
    onSave({
      name: name.trim(),
      collection: collection.trim(),
      destination,
      config:
        destination === "storage"
          ? { prefix: prefix.trim() || "cdc" }
          : { url: url.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}) },
      ...(shape.trim() ? { shape: shape.trim() } : {}),
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[560px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            <Trans>New CDC sink</Trans>
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>
              It starts from the beginning of the collection and catches up one page per tick.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">{t`Name`}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="warehouse" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">{t`Collection`}</span>
              <Input
                className="font-mono"
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
                placeholder="orders"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">{t`Destination`}</span>
              <Select
                className="min-w-0"
                value={destination}
                onChange={setDestination}
                options={[
                  { value: "webhook", label: t`Webhook — POST each batch to a URL` },
                  { value: "storage", label: t`Storage — NDJSON in this workspace's bucket` },
                ]}
              />
            </label>

            {destination === "webhook" ? (
              <>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-medium">{t`URL`}</span>
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://ingest.example.com/backlex"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-medium">{t`Signing secret`}</span>
                  <Input
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    <Trans>
                      Optional. Signs each batch with Standard Webhooks headers, so a verifier you
                      already have for our auth hooks works here too.
                    </Trans>
                  </span>
                </label>
              </>
            ) : (
              <label className="block">
                <span className="mb-1 block text-[11.5px] font-medium">{t`Key prefix`}</span>
                <Input
                  className="font-mono"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  <Trans>
                    Objects land in this workspace's bucket, where the S3 endpoint can read them.
                  </Trans>
                </span>
              </label>
            )}

            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">{t`Shape`}</span>
              <Textarea
                className="font-mono"
                rows={2}
                value={shape}
                onChange={(e) => setShape(e.target.value)}
                placeholder={SHAPE_EXAMPLE}
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                <Trans>
                  Optional filter naming the subset to replicate. A row that stops matching is
                  delivered as an exit marker, so the destination knows to drop it.
                </Trans>
              </span>
            </label>
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={submit} disabled={!ready}>
            <Trans>Create</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Outside the translated strings — a literal `{` in a lingui message is an
 *  ICU placeholder, and an unmatched one blank-screens the admin. */
const SHAPE_EXAMPLE = '{"region":{"_eq":"eu"}}';
