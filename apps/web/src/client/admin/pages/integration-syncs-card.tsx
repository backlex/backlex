// Source syncs — the inbound half of integrations, shown under the provider
// grid so the two directions sit together: a sink is sent events, a source
// brings rows in.
//
// The editor's job is to stop three mistakes that are cheap to make and
// expensive to notice. The mapping target is a dropdown of the collection's own
// fields, because a typo there would be refused by the server but only after the
// admin had filled the whole form. The interval is a dropdown too, since the
// useful values are a short list and "0" needs explaining. And "run now" is
// offered right after creating, because a schedule that silently never fires
// looks identical to one that has not come round yet.
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { Badge, Button, EmptyState, relativeTime } from "../ui";
import { Select } from "../select";
import { Input } from "@backlex/ui/components/input";
import { Card } from "@backlex/ui/components/card";
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
import { api } from "@/lib/api";
import { useCollections } from "../queries";
import { fetchSafely } from "./_shared";

export type SettingField = {
  key: string;
  label: string;
  placeholder?: string;
  /** Present when the field is a choice; the UI renders a picker, not a box. */
  options?: { value: string; label: string }[];
};

export type ApiSync = {
  id: string;
  integrationId: string;
  collection: string;
  settings: Record<string, unknown>;
  mapping: Record<string, string>;
  intervalMinutes: number;
  enabled: boolean;
  resuming: boolean;
  lastRunAt: number | string | null;
  lastRowCount: number;
  lastError: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
};

/** Connected integrations that can act as a source, for the picker. */
export type SourceOption = { id: string; kind: string; label: string };

/** Cadences worth offering. The labels live at the call site rather than here,
 *  because Lingui extracts `t` only where it is lexically in scope — passing it
 *  in as a parameter compiles and runs, but the string never reaches a catalog
 *  and silently stays English in every locale. */
const INTERVAL_MINUTES = [15, 30, 60, 180, 720, 1440] as const;

export function IntegrationSyncsCard({
  sources,
  settingFields,
  pushToast,
}: {
  sources: SourceOption[];
  settingFields: Record<string, SettingField[]>;
  pushToast: (m: string) => void;
}) {
  const { t } = useLingui();
  const [syncs, setSyncs] = useState<ApiSync[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      // The table may predate the migration on an older instance — an empty
      // list is the right rendering, not an error.
      const res = await fetchSafely<{ data: ApiSync[] }>("/api/admin/integrations/syncs");
      if (!live) return;
      setSyncs(res?.data ?? []);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  const labelFor = (integrationId: string) =>
    sources.find((s) => s.id === integrationId)?.label ?? t`Disconnected source`;

  const create = async (input: Record<string, unknown>) => {
    const snapshot = syncs;
    setEditing(false);
    try {
      const res = await api<{ data: ApiSync }>("/api/admin/integrations/syncs", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setSyncs([...snapshot, res.data]);
      pushToast(t`Sync created. Run it now to check the mapping.`);
    } catch (e) {
      setSyncs(snapshot);
      pushToast((e as Error).message);
    }
  };

  const toggle = async (row: ApiSync) => {
    const snapshot = syncs;
    const next = !row.enabled;
    setSyncs(
      snapshot.map((s) =>
        s.id === row.id
          ? { ...s, enabled: next, ...(next ? { consecutiveFailures: 0, disabledReason: null } : {}) }
          : s,
      ),
    );
    try {
      const res = await api<{ data: ApiSync }>(`/api/admin/integrations/syncs/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: next }),
      });
      setSyncs((prev) => prev.map((s) => (s.id === row.id ? res.data : s)));
    } catch (e) {
      setSyncs(snapshot);
      pushToast((e as Error).message);
    }
  };

  const remove = async (row: ApiSync) => {
    const snapshot = syncs;
    setSyncs(snapshot.filter((s) => s.id !== row.id));
    try {
      await api(`/api/admin/integrations/syncs/${row.id}`, { method: "DELETE" });
      pushToast(t`Sync deleted. Rows already pulled stay in the collection.`);
    } catch (e) {
      setSyncs(snapshot);
      pushToast((e as Error).message);
    }
  };

  const runNow = async (row: ApiSync) => {
    setBusy(row.id);
    try {
      const res = await api<{ data: { written: number; complete: boolean } }>(
        `/api/admin/integrations/syncs/${row.id}/run`,
        { method: "POST" },
      );
      pushToast(
        res.data.complete
          ? t`Pulled ${res.data.written} rows into ${row.collection}.`
          : t`Pulled ${res.data.written} rows; more pages resume on the schedule.`,
      );
      const list = await fetchSafely<{ data: ApiSync[] }>("/api/admin/integrations/syncs");
      if (list) setSyncs(list.data);
    } catch (e) {
      pushToast((e as Error).message);
      const list = await fetchSafely<{ data: ApiSync[] }>("/api/admin/integrations/syncs");
      if (list) setSyncs(list.data);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold -tracking-[0.01em]">
            <Trans>Data syncs</Trans>
          </h2>
          <p className="text-[12.5px] text-muted-foreground">
            <Trans>
              Pull rows from a connected source into a collection on a schedule. Pulled rows update in place
              and never overwrite rows created here.
            </Trans>
          </p>
        </div>
        <Button
          className="ml-auto shrink-0"
          disabled={sources.length === 0}
          onClick={() => setEditing(true)}
        >
          <Trans>Add sync</Trans>
        </Button>
      </div>

      {!loaded ? (
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : sources.length === 0 ? (
        <EmptyState
          icon={I.Download}
          title={t`No source connected`}
          description={t`Connect Google Sheets, Airtable or Notion above, authorize it, then schedule a pull.`}
          size="sm"
        />
      ) : syncs.length === 0 ? (
        <EmptyState
          icon={I.Download}
          title={t`No syncs`}
          description={t`Point a connected source at a collection and pick how often it should run.`}
          size="sm"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {syncs.map((row) => (
            <Card
              key={row.id}
              className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{labelFor(row.integrationId)}</span>
                  <I.ArrowRight size={13} className="text-muted-foreground" />
                  <code className="text-[12px] text-muted-foreground">{row.collection}</code>
                  {!row.enabled && (
                    <Badge variant="destructive" className="text-[10px]">
                      <Trans>Paused</Trans>
                    </Badge>
                  )}
                  {row.enabled && row.resuming && (
                    <Badge variant="secondary" className="text-[10px]">
                      <Trans>More pages pending</Trans>
                    </Badge>
                  )}
                  {row.enabled && row.intervalMinutes === 0 && (
                    <Badge variant="secondary" className="text-[10px]">
                      <Trans>Manual only</Trans>
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                  {row.intervalMinutes > 0 ? (
                    <Trans>every {row.intervalMinutes} min</Trans>
                  ) : (
                    <Trans>runs only when you ask</Trans>
                  )}
                  {row.lastRunAt ? (
                    <>
                      {" · "}
                      <Trans>
                        {row.lastRowCount} rows {relativeTime(row.lastRunAt)}
                      </Trans>
                    </>
                  ) : (
                    <>
                      {" · "}
                      <Trans>never run</Trans>
                    </>
                  )}
                </div>
                {row.disabledReason ?? row.lastError ? (
                  <p className="mt-1 text-[11.5px] leading-snug text-destructive">
                    {row.disabledReason ?? row.lastError}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                <Button variant="ghost" disabled={busy === row.id} onClick={() => void runNow(row)}>
                  {busy === row.id ? <Trans>Pulling…</Trans> : <Trans>Run now</Trans>}
                </Button>
                <Button variant="ghost" onClick={() => void toggle(row)}>
                  {row.enabled ? <Trans>Pause</Trans> : <Trans>Resume</Trans>}
                </Button>
                <Button variant="ghost" onClick={() => void remove(row)}>
                  <Trans>Delete</Trans>
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <SyncDialog
          sources={sources}
          settingFields={settingFields}
          onClose={() => setEditing(false)}
          onCreate={(input) => void create(input)}
        />
      )}
    </section>
  );
}

/* ── Point a source at a collection ─────────────────────────────────────── */
function SyncDialog({
  sources,
  settingFields,
  onClose,
  onCreate,
}: {
  sources: SourceOption[];
  settingFields: Record<string, SettingField[]>;
  onClose: () => void;
  onCreate: (input: Record<string, unknown>) => void;
}) {
  const { t } = useLingui();
  const collectionsQuery = useCollections();
  const collections = collectionsQuery.data?.data ?? [];

  const [integrationId, setIntegrationId] = useState(sources[0]?.id ?? "");
  const [collection, setCollection] = useState("");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [interval, setInterval] = useState(60);
  // Stable ids rather than the array index: rows can be removed, and an index
  // key would make React reuse the wrong input's state when one disappears.
  const [pairs, setPairs] = useState<{ id: string; external: string; field: string }[]>([
    { id: crypto.randomUUID(), external: "", field: "" },
  ]);

  const kind = sources.find((s) => s.id === integrationId)?.kind ?? "";
  const fields = settingFields[kind] ?? [];

  // Only writable fields can be a mapping target; a computed column regenerates
  // itself and the server would refuse it anyway.
  const targetOptions = useMemo(() => {
    const c = collections.find((x) => x.slug === collection) as
      | { fields?: { name: string; computed?: boolean }[] }
      | undefined;
    return (c?.fields ?? [])
      .filter((f) => !f.computed)
      .map((f) => ({ value: f.name, label: f.name }));
  }, [collections, collection]);

  // Written out rather than derived: `Every ${m / 60} hours` renders
  // "Every 1 hours" for the default cadence.
  const intervalLabel = (m: number) =>
    m === 15
      ? t`Every 15 minutes`
      : m === 30
        ? t`Every 30 minutes`
        : m === 60
          ? t`Hourly`
          : m === 180
            ? t`Every 3 hours`
            : m === 720
              ? t`Every 12 hours`
              : t`Daily`;

  const ready =
    Boolean(integrationId) &&
    Boolean(collection) &&
    fields.every((f) => f.label.toLowerCase().includes("optional") || (settings[f.key] ?? "").trim()) &&
    pairs.some((p) => p.external.trim() && p.field);

  const submit = () => {
    const mapping: Record<string, string> = {};
    for (const p of pairs) if (p.external.trim() && p.field) mapping[p.external.trim()] = p.field;
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings)) if (v.trim()) cleaned[k] = v.trim();
    onCreate({ integrationId, collection, settings: cleaned, mapping, intervalMinutes: interval });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[min(86vh,760px)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            <Trans>New data sync</Trans>
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>
              Rows land in an ordinary collection, so permissions, querying and exports apply to them like any
              other data.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea viewportClassName="max-h-[calc(min(86vh,760px)-10rem)] max-[640px]:max-h-[calc(min(86vh,760px)-15rem)]">
          <div className="flex flex-col gap-3.5 px-5 py-4">
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Source</Trans>
              </span>
              <Select
                value={integrationId}
                onChange={(v: string) => {
                  setIntegrationId(v);
                  // Settings belong to a provider; carrying them across would
                  // send a spreadsheet id to Airtable.
                  setSettings({});
                }}
                options={sources.map((s) => ({ value: s.id, label: s.label }))}
                className="min-w-0"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Into collection</Trans>
              </span>
              <Select
                // `undefined`, not `""`: the shared Select maps "" to a
                // sentinel meaning "an option with an empty value is selected",
                // which suppresses the placeholder and leaves a blank trigger.
                value={collection || undefined}
                onChange={(v: string) => {
                  setCollection(v);
                  // Targets are that collection's fields, so a change invalidates
                  // whatever was picked.
                  setPairs([{ id: crypto.randomUUID(), external: "", field: "" }]);
                }}
                placeholder={t`Pick a collection`}
                options={collections.map((c) => ({ value: c.slug, label: c.slug }))}
                className="min-w-0"
              />
            </label>

            {fields.map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1 block text-[11.5px] font-medium">{f.label}</span>
                {f.options ? (
                  // A closed set the server enforces anyway — typing it would
                  // fail on submit with a list the operator had to guess at.
                  <Select
                    value={settings[f.key] || undefined}
                    onChange={(v: string) => setSettings((s) => ({ ...s, [f.key]: v }))}
                    placeholder={f.placeholder ?? t`Choose one`}
                    options={f.options}
                    className="min-w-0"
                  />
                ) : (
                  <Input
                    placeholder={f.placeholder}
                    value={settings[f.key] ?? ""}
                    onChange={(e) => setSettings((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                )}
              </label>
            ))}

            <div>
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Field mapping</Trans>{" "}
                <span className="font-normal text-muted-foreground">
                  · <Trans>unmapped columns are dropped</Trans>
                </span>
              </span>
              <div className="flex flex-col gap-2">
                {pairs.map((p) => (
                  <div key={p.id} className="flex items-center gap-2">
                    <Input
                      className="min-w-0 flex-1"
                      placeholder={t`External column`}
                      value={p.external}
                      onChange={(e) =>
                        setPairs((prev) =>
                          prev.map((x) => (x.id === p.id ? { ...x, external: e.target.value } : x)),
                        )
                      }
                    />
                    <I.ArrowRight size={13} className="shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <Select
                        value={p.field || undefined}
                        onChange={(v: string) =>
                          setPairs((prev) => prev.map((x) => (x.id === p.id ? { ...x, field: v } : x)))
                        }
                        placeholder={collection ? t`Field` : t`Pick a collection first`}
                        options={targetOptions}
                        className="min-w-0"
                      />
                    </div>
                    <Button
                      variant="ghost"
                      className="shrink-0 px-2"
                      aria-label={t`Remove column`}
                      disabled={pairs.length === 1}
                      onClick={() => setPairs((prev) => prev.filter((x) => x.id !== p.id))}
                    >
                      <I.X size={13} />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                variant="ghost"
                className="mt-1.5"
                onClick={() =>
                  setPairs((prev) => [...prev, { id: crypto.randomUUID(), external: "", field: "" }])
                }
              >
                <Trans>Add column</Trans>
              </Button>
            </div>

            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Run</Trans>
              </span>
              <Select
                value={String(interval)}
                onChange={(v: string) => setInterval(Number(v))}
                options={[
                  // 0 needs saying out loud — "manual" is not a duration.
                  { value: "0", label: t`Only when I ask` },
                  ...INTERVAL_MINUTES.map((m) => ({ value: String(m), label: intervalLabel(m) })),
                ]}
                className="min-w-0"
              />
            </label>
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={!ready} onClick={submit}>
            <Trans>Create sync</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
