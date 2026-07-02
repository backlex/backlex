// Database import — server-side external-DB migration (docs/migrating-in.md).
// Saved source connections (URLs masked), a table-pick → plan-review wizard,
// and the runs list with live per-table progress (poll while active). The
// heavy lifting happens in services/migrate.ts on the scheduler tick; this
// page only starts/cancels/resumes runs and watches state.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import {
  Badge,
  type BadgeVariant,
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  relativeTime,
} from "../ui";
import { Select } from "../select";
import { ConfirmDialog } from "../sheet";
import { Input } from "@backlex/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { Checkbox } from "@backlex/ui/components/checkbox";
import {
  migrateApi,
  type ApiMigratePlan,
  type ApiMigrateRun,
  type ApiMigrateRunStatus,
  type ApiMigrateSource,
} from "../api";

const STATUS_VARIANT: Record<ApiMigrateRunStatus, BadgeVariant> = {
  pending: "outline",
  running: "secondary",
  done: "default",
  failed: "destructive",
  cancelled: "outline",
};

interface PageProps {
  pushToast: (m: string, type?: "success" | "error") => void;
}

export function DatabaseImportPage({ pushToast }: PageProps) {
  const { t } = useLingui();
  const [sources, setSources] = useState<ApiMigrateSource[]>([]);
  const [runs, setRuns] = useState<ApiMigrateRun[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Add-source dialog
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ApiMigrateSource | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  // Wizard dialog
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardSource, setWizardSource] = useState<string | undefined>(undefined);
  const [tables, setTables] = useState<{ name: string; approxRows: number | null }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<ApiMigratePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([migrateApi.sources(), migrateApi.runs()]);
      setSources(s.data);
      setRuns(r.data);
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setLoaded(true);
    }
  }, [pushToast]);
  useEffect(() => {
    void reload();
  }, [reload]);

  // Poll runs while one is in flight — the executor advances on the cron
  // tick, so state changes land every few seconds.
  const hasActive = runs.some((r) => r.status === "pending" || r.status === "running");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!hasActive) return;
    pollRef.current = setInterval(() => {
      void migrateApi
        .runs()
        .then((r) => setRuns(r.data))
        .catch(() => {});
    }, 2500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [hasActive]);

  const sourceName = useCallback(
    (id: string) => sources.find((s) => s.id === id)?.name ?? id.slice(0, 8),
    [sources],
  );

  // ── Sources ──────────────────────────────────────────────────────────────

  const addSource = async () => {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName || !trimmedUrl) return;
    setSaving(true);
    try {
      const created = await migrateApi.createSource(trimmedName, trimmedUrl);
      setSources((cur) => [...cur, created.data].sort((a, b) => a.name.localeCompare(b.name)));
      setAddOpen(false);
      setName("");
      setUrl("");
      pushToast(t`Source saved. The connection string is encrypted at rest.`);
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const deleteSource = async (source: ApiMigrateSource) => {
    const prev = sources;
    setSources((cur) => cur.filter((s) => s.id !== source.id));
    try {
      await migrateApi.deleteSource(source.id);
      pushToast(t`Source deleted.`);
    } catch (e) {
      setSources(prev);
      pushToast((e as Error).message, "error");
    }
  };

  const testSource = async (source: ApiMigrateSource) => {
    setTestingId(source.id);
    try {
      const r = await migrateApi.testSource(source.id);
      if (r.data.ok) pushToast(t`Reachable — ${r.data.tables ?? 0} tables found.`);
      else pushToast(r.data.error ?? t`Connection failed.`, "error");
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setTestingId(null);
    }
  };

  // ── Wizard ───────────────────────────────────────────────────────────────

  const openWizard = (sourceId?: string) => {
    setWizardSource(sourceId ?? sources[0]?.id);
    setTables(null);
    setPicked(new Set());
    setPlan(null);
    setWizardOpen(true);
  };

  useEffect(() => {
    if (!wizardOpen || !wizardSource) return;
    setTables(null);
    setPlan(null);
    void migrateApi
      .sourceTables(wizardSource)
      .then((r) => {
        setTables(r.data);
        setPicked(new Set(r.data.map((x) => x.name)));
      })
      .catch((e) => {
        pushToast((e as Error).message, "error");
        setTables([]);
      });
  }, [wizardOpen, wizardSource, pushToast]);

  const buildPlan = async () => {
    if (!wizardSource || picked.size === 0) return;
    setPlanning(true);
    try {
      const r = await migrateApi.plan(wizardSource, [...picked]);
      setPlan(r.data);
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setPlanning(false);
    }
  };

  const startRun = async () => {
    if (!wizardSource || !plan) return;
    setStarting(true);
    try {
      const r = await migrateApi.startRun(wizardSource, plan);
      setRuns((cur) => [r.data, ...cur]);
      setWizardOpen(false);
      pushToast(t`Migration queued — it advances on the scheduler tick.`);
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setStarting(false);
    }
  };

  // ── Runs ─────────────────────────────────────────────────────────────────

  const patchRun = (id: string, next: ApiMigrateRun) =>
    setRuns((cur) => cur.map((r) => (r.id === id ? next : r)));

  const cancelRun = async (run: ApiMigrateRun) => {
    const prev = runs;
    setRuns((cur) =>
      cur.map((r) => (r.id === run.id ? { ...r, status: "cancelled" as const } : r)),
    );
    try {
      const r = await migrateApi.cancelRun(run.id);
      patchRun(run.id, r.data);
      pushToast(t`Run cancelled. Progress is kept — resume any time.`);
    } catch (e) {
      setRuns(prev);
      pushToast((e as Error).message, "error");
    }
  };

  const resumeRun = async (run: ApiMigrateRun) => {
    const prev = runs;
    setRuns((cur) =>
      cur.map((r) => (r.id === run.id ? { ...r, status: "pending" as const, error: null } : r)),
    );
    try {
      const r = await migrateApi.resumeRun(run.id);
      patchRun(run.id, r.data);
      pushToast(t`Run re-queued — the copy continues where it stopped.`);
    } catch (e) {
      setRuns(prev);
      pushToast((e as Error).message, "error");
    }
  };

  const statusLabel = (s: ApiMigrateRunStatus): string =>
    s === "pending" ? t`Pending`
    : s === "running" ? t`Running`
    : s === "done" ? t`Done`
    : s === "failed" ? t`Failed`
    : t`Cancelled`;

  const includedTables = useMemo(() => plan?.tables.filter((x) => x.include) ?? [], [plan]);

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Database import`}
        description={t`Copy an external Postgres database into collections — primary keys preserved, relations intact, resumable. For databases the server can't reach, use the backlex import-db CLI.`}
        actions={
          <div className="flex items-center gap-2">
            <IconButton icon={I.Refresh} title={t`Refresh`} onClick={() => void reload()} />
            <Button variant="outline" icon={I.Plus} onClick={() => setAddOpen(true)}>
              <Trans>Add source</Trans>
            </Button>
            <Button
              variant="primary"
              icon={I.Download}
              onClick={() => openWizard()}
              disabled={loaded && sources.length === 0}
            >
              <Trans>New migration</Trans>
            </Button>
          </div>
        }
      />

      {/* Sources */}
      <Card className="py-0 gap-0">
        <div className="border-b border-border px-4 py-2.5 text-[12.5px] font-medium text-muted-foreground">
          <Trans>Sources</Trans>
        </div>
        {!loaded ? (
          <div className="flex flex-col">
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-64 max-sm:hidden" />
                <Skeleton className="ml-auto h-4 w-24" />
              </div>
            ))}
          </div>
        ) : sources.length === 0 ? (
          <EmptyState
            size="md"
            icon={I.Database}
            title={<Trans>No sources yet</Trans>}
            description={<Trans>Save a Postgres connection string to migrate its data in. Credentials are encrypted at rest and never shown again.</Trans>}
          />
        ) : (
          <div className="flex flex-col">
            {sources.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 last:border-b-0"
              >
                <span className="text-[13px] font-medium">{s.name}</span>
                <span className="truncate font-mono text-[12px] text-muted-foreground">
                  {s.urlMasked}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void testSource(s)}
                    disabled={testingId === s.id}
                  >
                    {testingId === s.id ? <Trans>Testing…</Trans> : <Trans>Test</Trans>}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => openWizard(s.id)}>
                    <Trans>Migrate</Trans>
                  </Button>
                  <IconButton
                    icon={I.Trash}
                    title={t`Delete source`}
                    onClick={() => setPendingDelete(s)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Runs */}
      <Card className="py-0 gap-0">
        <div className="border-b border-border px-4 py-2.5 text-[12.5px] font-medium text-muted-foreground">
          <Trans>Runs</Trans>
        </div>
        {!loaded ? (
          <div className="flex flex-col">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="ml-auto h-4 w-28" />
              </div>
            ))}
          </div>
        ) : runs.length === 0 ? (
          <EmptyState
            size="md"
            icon={I.Download}
            title={<Trans>No migrations yet</Trans>}
            description={<Trans>Start one with “New migration” — pick tables, review the plan, and the server copies the rows in the background.</Trans>}
          />
        ) : (
          <div className="flex flex-col">
            {runs.map((run) => {
              const tablesState = Object.entries(run.state?.tables ?? {});
              const copied = tablesState.reduce((n, [, x]) => n + x.copied, 0);
              const failedRows = tablesState.reduce((n, [, x]) => n + x.failed, 0);
              const doneTables = tablesState.filter(([, x]) => x.done).length;
              return (
                <div key={run.id} className="flex flex-col gap-1.5 border-b border-border px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Badge variant={STATUS_VARIANT[run.status]}>{statusLabel(run.status)}</Badge>
                    <span className="text-[13px] font-medium">{sourceName(run.sourceId)}</span>
                    <span className="text-[12px] text-muted-foreground">
                      {relativeTime(run.createdAt)}
                    </span>
                    <span className="text-[12px] tabular-nums text-muted-foreground">
                      <Trans>
                        {doneTables}/{tablesState.length} tables · {copied} rows
                      </Trans>
                      {failedRows > 0 && (
                        <span className="text-destructive"> · {failedRows} <Trans>failed</Trans></span>
                      )}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      {(run.status === "pending" || run.status === "running") && (
                        <Button variant="ghost" size="sm" onClick={() => void cancelRun(run)}>
                          <Trans>Cancel</Trans>
                        </Button>
                      )}
                      {(run.status === "failed" || run.status === "cancelled") && (
                        <Button variant="ghost" size="sm" onClick={() => void resumeRun(run)}>
                          <Trans>Resume</Trans>
                        </Button>
                      )}
                    </div>
                  </div>
                  {run.error && (
                    <div className="text-[12px] text-destructive">{run.error}</div>
                  )}
                  {(run.status === "running" || run.status === "pending" || failedRows > 0) && (
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      {tablesState.map(([slug, x]) => (
                        <span key={slug} className="text-[11.5px] tabular-nums text-muted-foreground">
                          {slug}: {x.copied}
                          {x.sourceCount !== undefined ? `/${x.sourceCount}` : ""}
                          {x.done ? " ✓" : "…"}
                          {x.failed > 0 ? ` (+${x.failed}!)` : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Add source */}
      <Dialog open={addOpen} onOpenChange={(o) => !o && setAddOpen(false)}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-[480px]">
          <DialogHeader className="shrink-0">
            <DialogTitle><Trans>Add source</Trans></DialogTitle>
            <DialogDescription>
              <Trans>A Postgres connection the server can reach. The URL is encrypted at rest and only ever shown masked.</Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium" htmlFor="mig-src-name">
                <Trans>Name</Trans>
              </label>
              <Input
                id="mig-src-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t`legacy production`}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium" htmlFor="mig-src-url">
                <Trans>Connection URL</Trans>
              </label>
              <Input
                id="mig-src-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="postgres://user:password@host:5432/db"
                type="password"
                autoComplete="off"
              />
              <p className="text-[11.5px] text-muted-foreground">
                <Trans>Supabase, Neon, RDS, Heroku — anything Postgres. If the database is on a private network, run the copy from your side with the backlex import-db CLI instead.</Trans>
              </p>
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="primary"
              onClick={() => void addSource()}
              disabled={saving || !name.trim() || !url.trim()}
            >
              {saving ? <Trans>Saving…</Trans> : <Trans>Save source</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New migration wizard */}
      <Dialog open={wizardOpen} onOpenChange={(o) => !o && setWizardOpen(false)}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-[640px]">
          <DialogHeader className="shrink-0">
            <DialogTitle><Trans>New migration</Trans></DialogTitle>
            <DialogDescription>
              {plan ? (
                <Trans>Review the plan — copy order follows foreign keys, primary keys are preserved verbatim.</Trans>
              ) : (
                <Trans>Pick the source tables to copy. Every table becomes a collection.</Trans>
              )}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea
            viewportClassName="max-h-[calc(85vh-12rem)] max-[640px]:max-h-[calc(85vh-16rem)]"
            className="w-full"
          >
            <div className="flex flex-col gap-3 pr-2">
              <Select
                value={wizardSource}
                onChange={(v) => setWizardSource(v)}
                options={sources.map((s) => ({ value: s.id, label: s.name }))}
                placeholder={t`Pick a source`}
              />
              {!plan && (
                <div className="flex flex-col gap-1">
                  {tables === null ? (
                    <div className="flex flex-col gap-2 py-1">
                      {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-5 w-full" />
                      ))}
                    </div>
                  ) : tables.length === 0 ? (
                    <p className="py-2 text-[12.5px] text-muted-foreground">
                      <Trans>No tables found in this source.</Trans>
                    </p>
                  ) : (
                    tables.map((tbl) => (
                      <label key={tbl.name} className="flex items-center gap-2.5 rounded px-1 py-1 text-[13px] hover:bg-accent">
                        <Checkbox
                          checked={picked.has(tbl.name)}
                          onCheckedChange={(v) =>
                            setPicked((cur) => {
                              const next = new Set(cur);
                              if (v) next.add(tbl.name);
                              else next.delete(tbl.name);
                              return next;
                            })
                          }
                        />
                        <span className="font-mono">{tbl.name}</span>
                        {tbl.approxRows !== null && (
                          <span className="ml-auto tabular-nums text-[11.5px] text-muted-foreground">
                            ~{tbl.approxRows.toLocaleString()}
                          </span>
                        )}
                      </label>
                    ))
                  )}
                </div>
              )}
              {plan && (
                <div className="flex flex-col gap-2.5">
                  <p className="text-[12px] text-muted-foreground">
                    <Trans>Copy order:</Trans>{" "}
                    <span className="font-mono">{plan.order.join(" → ")}</span>
                  </p>
                  {plan.tables.map((tbl) => (
                    <div key={tbl.table} className="rounded-md border border-border px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[12.5px] font-medium">{tbl.table}</span>
                        {tbl.include ? (
                          <>
                            <I.ArrowRight size={12} className="text-muted-foreground" />
                            <span className="font-mono text-[12.5px]">{tbl.slug}</span>
                            <Badge variant="outline">
                              {tbl.fields.length} <Trans>fields</Trans>
                            </Badge>
                            <Badge variant="outline">pk:{tbl.pkType}</Badge>
                          </>
                        ) : (
                          <Badge variant="destructive"><Trans>Excluded</Trans></Badge>
                        )}
                      </div>
                      {!tbl.include && tbl.reason && (
                        <p className="mt-1 text-[11.5px] text-destructive">{tbl.reason}</p>
                      )}
                      {tbl.warnings.map((w) => (
                        <p key={w} className="mt-1 text-[11.5px] text-muted-foreground">
                          ⚠ {w}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
          <DialogFooter className="shrink-0">
            {plan ? (
              <>
                <Button variant="outline" onClick={() => setPlan(null)}>
                  <Trans>Back</Trans>
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void startRun()}
                  disabled={starting || includedTables.length === 0}
                >
                  {starting ? (
                    <Trans>Starting…</Trans>
                  ) : (
                    <Trans>Start migration ({includedTables.length} tables)</Trans>
                  )}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setWizardOpen(false)}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void buildPlan()}
                  disabled={planning || !wizardSource || picked.size === 0}
                >
                  {planning ? <Trans>Inspecting…</Trans> : <Trans>Build plan</Trans>}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        destructive
        title={t`Delete source?`}
        description={
          pendingDelete
            ? t`Delete "${pendingDelete.name}"? Its saved connection string is destroyed; past runs are removed with it. Copied data stays.`
            : ""
        }
        actionLabel={t`Delete`}
        onConfirm={() => {
          const s = pendingDelete;
          setPendingDelete(null);
          if (s) void deleteSource(s);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
