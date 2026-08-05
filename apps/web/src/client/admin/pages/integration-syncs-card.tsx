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
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { api } from "@/lib/api";
// The descriptor subpath, not the package root: it imports nothing, so the
// column rules are shared with the server without every provider adapter
// landing in the admin bundle.
import { columnsForSettings, type DestinationColumn } from "@backlex/integrations/provider";
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
  direction: string;
  intervalMinutes: number;
  enabled: boolean;
  resuming: boolean;
  lastRunAt: number | string | null;
  lastRowCount: number;
  lastError: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
};

/** A connected integration the picker can offer, with which way it travels. */
export type SourceOption = { id: string; kind: string; label: string; direction: "pull" | "push" };

/** Identifies one ROW of the picker. A connection that can travel both ways
 *  appears twice under one id, so the direction has to be part of the key. */
const keyOf = (s: SourceOption): string => `${s.id}:${s.direction}`;

/** Cadences worth offering. The labels live at the call site rather than here,
 *  because Lingui extracts `t` only where it is lexically in scope — passing it
 *  in as a parameter compiles and runs, but the string never reaches a catalog
 *  and silently stays English in every locale. */
const INTERVAL_MINUTES = [15, 30, 60, 180, 720, 1440] as const;

export function IntegrationSyncsCard({
  sources,
  settingFields,
  destinationColumns,
  pushToast,
}: {
  /** Both directions; the dialog reads `direction` off the chosen entry. */
  sources: SourceOption[];
  /** Keyed `<kind>:<direction>` so one provider can declare both. */
  settingFields: Record<string, SettingField[]>;
  /** Destinations with a closed column set, keyed by kind. Absent = free text. */
  destinationColumns: Record<string, DestinationColumn[]>;
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
          size="md"
        />
      ) : syncs.length === 0 ? (
        <EmptyState
          icon={I.Download}
          title={t`No syncs`}
          description={t`Point a connected source at a collection and pick how often it should run.`}
          size="md"
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
                  {/* Drawn in the direction of travel, so a glance says which
                      way the rows are moving. Showing a push as
                      "ClickHouse → leads" would say the opposite of what
                      happens. */}
                  <span className="text-[13px] font-medium">
                    {row.direction === "push" ? row.collection : labelFor(row.integrationId)}
                  </span>
                  <I.ArrowRight size={13} className="text-muted-foreground" />
                  <code className="text-[12px] text-muted-foreground">
                    {row.direction === "push" ? labelFor(row.integrationId) : row.collection}
                  </code>
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
          destinationColumns={destinationColumns}
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
  destinationColumns,
  onClose,
  onCreate,
}: {
  sources: SourceOption[];
  settingFields: Record<string, SettingField[]>;
  destinationColumns: Record<string, DestinationColumn[]>;
  onClose: () => void;
  onCreate: (input: Record<string, unknown>) => void;
}) {
  const { t } = useLingui();
  const collectionsQuery = useCollections();
  const collections = collectionsQuery.data?.data ?? [];

  // Keyed by connection AND direction, never by id alone. A provider that can
  // do both — Google Calendar mirrors a calendar in and writes bookings out —
  // appears twice with the SAME connection id, so an id-keyed picker collapses
  // the two into one option and the second direction becomes unreachable.
  const [selectionKey, setSelectionKey] = useState(sources[0] ? keyOf(sources[0]) : "");
  const [collection, setCollection] = useState("");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [interval, setInterval] = useState(60);
  // Stable ids rather than the array index: rows can be removed, and an index
  // key would make React reuse the wrong input's state when one disappears.
  const [pairs, setPairs] = useState<{ id: string; external: string; field: string }[]>([
    { id: crypto.randomUUID(), external: "", field: "" },
  ]);

  /** Connections offered in both directions, so the picker can say which. */
  const bothWays = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const s of sources) {
      if (seen.has(s.id)) dupes.add(s.id);
      seen.add(s.id);
    }
    return dupes;
  }, [sources]);

  const chosen = sources.find((s) => keyOf(s) === selectionKey);
  const integrationId = chosen?.id ?? "";
  const direction = chosen?.direction ?? "pull";
  const fields = settingFields[`${chosen?.kind ?? ""}:${direction}`] ?? [];
  // A destination that writes into a structured object (a calendar event) has a
  // fixed set of targets; a warehouse's are whatever its DDL declared and stay
  // free text. The server refuses an unknown one either way — this is so the
  // operator doesn't have to guess the spelling.
  //
  // Narrowed by the settings, because some providers' targets depend on them:
  // QuickBooks writes customers OR invoices, and offering `dueDate` on a
  // customer sync is a trap that only shows up as a column nobody wrote.
  const allColumns = direction === "push" ? destinationColumns[chosen?.kind ?? ""] : undefined;
  const externalOptions = useMemo(
    () => (allColumns ? columnsForSettings(allColumns, settings) : undefined),
    [allColumns, settings],
  );

  /** Change one setting, and drop any mapping target it just invalidated —
   *  switching a QuickBooks sync from customers to invoices otherwise leaves
   *  `email` selected in a picker that no longer offers it. */
  const setSetting = (key: string, value: string) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    if (!allColumns) return;
    const still = new Set(columnsForSettings(allColumns, next).map((c) => c.value));
    setPairs((prev) =>
      prev.map((p) =>
        still.has(p.external)
          ? p
          : // A NEW id, not just a cleared value: Radix's Select keeps showing
            // the last item it rendered when its value goes back to undefined,
            // so a cleared row would sit there displaying a column that is no
            // longer on offer. Changing the key remounts it onto the placeholder.
            { ...p, id: crypto.randomUUID(), external: "" },
      ),
    );
  };

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
    // Written in the direction of travel: the collection field is the value on
    // a pull and the key on a push.
    for (const p of pairs) {
      if (!p.external.trim() || !p.field) continue;
      if (direction === "push") mapping[p.field] = p.external.trim();
      else mapping[p.external.trim()] = p.field;
    }
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings)) if (v.trim()) cleaned[k] = v.trim();
    onCreate({
      integrationId,
      collection,
      direction,
      settings: cleaned,
      mapping,
      intervalMinutes: interval,
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[560px]">
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

        <DialogBody>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Connection</Trans>
              </span>
              <Select
                value={selectionKey}
                onChange={(v: string) => {
                  setSelectionKey(v);
                  // Settings belong to a provider AND a direction; carrying them
                  // across would send a spreadsheet id to Airtable, or a
                  // calendar id to a pull.
                  setSettings({});
                  setPairs([{ id: crypto.randomUUID(), external: "", field: "" }]);
                }}
                options={sources.map((s) => ({
                  value: keyOf(s),
                  // Two rows carrying the same provider name are otherwise
                  // indistinguishable in the list.
                  label: bothWays.has(s.id)
                    ? `${s.label} · ${s.direction === "push" ? t`rows out` : t`rows in`}`
                    : s.label,
                }))}
                className="min-w-0"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">
                {direction === "push" ? <Trans>From collection</Trans> : <Trans>Into collection</Trans>}
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
                    onChange={(v: string) => setSetting(f.key, v)}
                    placeholder={f.placeholder ?? t`Choose one`}
                    options={f.options}
                    className="min-w-0"
                  />
                ) : (
                  <Input
                    placeholder={f.placeholder}
                    value={settings[f.key] ?? ""}
                    onChange={(e) => setSetting(f.key, e.target.value)}
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
                    {externalOptions ? (
                      <div className="min-w-0 flex-1">
                        <Select
                          value={p.external || undefined}
                          onChange={(v: string) =>
                            setPairs((prev) =>
                              prev.map((x) => (x.id === p.id ? { ...x, external: v } : x)),
                            )
                          }
                          placeholder={t`Destination column`}
                          options={externalOptions}
                          className="min-w-0"
                        />
                      </div>
                    ) : (
                      <Input
                        className="min-w-0 flex-1"
                        placeholder={direction === "push" ? t`Destination column` : t`External column`}
                        value={p.external}
                        onChange={(e) =>
                          setPairs((prev) =>
                            prev.map((x) => (x.id === p.id ? { ...x, external: e.target.value } : x)),
                          )
                        }
                      />
                    )}
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
        </DialogBody>

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
