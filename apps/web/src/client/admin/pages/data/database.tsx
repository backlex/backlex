import type { PushToast } from "../../types";
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { ADAPTER_PROFILES, type AdapterId } from "../../config";
import { Badge, Button, EmptyState, PageHeader, Switch } from "../../ui";
import { ConfirmDialog } from "../../sheet";
import { useUrlTab } from "../../use-url-tab";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Card } from "@backlex/ui/components/card";
import { dbAdminApi, jobsApi, type BackupConfig } from "../../api";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

const DATABASE_TABS = ["sql", "migrations", "backups"] as const;

export function DatabasePage({ pushToast, adapter }: { pushToast: PushToast; adapter: AdapterId }) {
  const { t } = useLingui();
  const [tab, setTab] = useUrlTab(DATABASE_TABS, "sql");
  const [migCount, setMigCount] = useState<number | null>(null);
  const [backupCount, setBackupCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [m, b] = await Promise.all([dbAdminApi.migrations(), dbAdminApi.backups()]);
        if (cancelled) return;
        setMigCount(Array.isArray(m.data) ? m.data.length : 0);
        setBackupCount(Array.isArray(b.data) ? b.data.length : 0);
      } catch {
        // leave counts null — tab badges hide when null
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const countCls = "rounded-sm border border-border bg-muted px-[5px] py-px font-mono text-[11px] text-muted-foreground";
  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Database`}
        description={<><Trans>Direct access to the underlying engine. Adapter: <span className="font-mono">{ADAPTER_PROFILES[adapter].db}</span>. SQL editor runs through the same permission layer as the API.</Trans></>}
        badges={<Badge variant="outline" mono>{ADAPTER_PROFILES[adapter].db}</Badge>}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as (typeof DATABASE_TABS)[number])}>
        <TabsList>
          <TabsTrigger value="sql"><I.Code size={13} /><Trans>SQL editor</Trans></TabsTrigger>
          <TabsTrigger value="migrations">
            <I.History size={13} /><Trans>Migrations</Trans>
            {migCount !== null && <span className={countCls}>{migCount}</span>}
          </TabsTrigger>
          <TabsTrigger value="backups">
            <I.Save size={13} /><Trans>Backups</Trans>
            {backupCount !== null && <span className={countCls}>{backupCount}</span>}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "sql" && <SqlEditor pushToast={pushToast} />}
      {tab === "migrations" && <Migrations pushToast={pushToast} />}
      {tab === "backups" && <Backups pushToast={pushToast} />}
    </div>
  );
}

const SNIPPET_TABLE_DEPS: Record<string, string> = {
  "Recent users": "users",
  "Active sessions": "sessions",
  "Recent activity": "activity",
  "Collections": "collections",
  "Largest files": "files",
  "API keys": "api_keys",
};
const SNIPPET_SQL: Record<string, string> = {
  "Recent users": 'SELECT id, email, name, created_at\nFROM "users"\nORDER BY created_at DESC\nLIMIT 20;',
  "Active sessions": 'SELECT user_id, ip_address, expires_at\nFROM "sessions"\nORDER BY created_at DESC\nLIMIT 20;',
  "Recent activity": 'SELECT action, collection, item_id, created_at\nFROM "activity"\nORDER BY created_at DESC\nLIMIT 50;',
  "Collections": 'SELECT slug, physical_table, owner_scoped\nFROM "collections"\nORDER BY slug;',
  "Largest files": 'SELECT key, content_type, size\nFROM "files"\nORDER BY size DESC\nLIMIT 20;',
  "API keys": 'SELECT prefix, name, user_id, last_used_at\nFROM "api_keys"\nORDER BY created_at DESC\nLIMIT 20;',
};
const quoteIdent = (n: string) => `"${n.replace(/"/g, '""')}"`;
const browseSql = (table: string) => `SELECT *\nFROM ${quoteIdent(table)}\nLIMIT 50;`;

function SqlEditor({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [sql, setSql] = useState("SELECT 1;");
  const [result, setResult] = useState<{ rows: Record<string, unknown>[]; ms: number; count: number }>({
    rows: [],
    ms: 0,
    count: 0,
  });
  const [running, setRunning] = useState(false);
  const [readOnly, setReadOnly] = useState(true);

  const [tables, setTables] = useState<{ name: string; rows: number }[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [tableFilter, setTableFilter] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await dbAdminApi.tables();
        if (cancelled) return;
        if (Array.isArray(r.data)) setTables(r.data);
      } catch {
        // leave tables empty
      } finally {
        if (!cancelled) setTablesLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filteredTables = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    return q ? tables.filter((t) => t.name.toLowerCase().includes(q)) : tables;
  }, [tables, tableFilter]);

  // Snippets are derived from the tables that actually exist in this database,
  // so every one of them runs without "no such table" errors.
  const snippets = useMemo<{ name: string; sql: string }[]>(() => {
    const names = new Set(tables.map((t) => t.name));
    const out: { name: string; sql: string }[] = [];
    for (const [name, dep] of Object.entries(SNIPPET_TABLE_DEPS)) {
      if (names.has(dep)) out.push({ name, sql: SNIPPET_SQL[name]! });
    }
    for (const t of tables.filter((t) => t.name.startsWith("c_")).slice(0, 5)) {
      out.push({ name: `Browse ${t.name}`, sql: browseSql(t.name) });
    }
    if (tables.length > 0) {
      const union = tables
        .map((t) => `SELECT '${t.name.replace(/'/g, "''")}' AS table_name, COUNT(*) AS rows FROM ${quoteIdent(t.name)}`)
        .join("\nUNION ALL\n");
      out.push({ name: "Row counts (all tables)", sql: `${union}\nORDER BY rows DESC;` });
    }
    return out;
  }, [tables]);

  const isWrite = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i.test(sql);
  const run = async () => {
    setRunning(true);
    try {
      const res = await dbAdminApi.runSql(sql, { writes: !readOnly && isWrite });
      const last = res.data[res.data.length - 1];
      const rows = (last?.rows ?? []) as Record<string, unknown>[];
      setResult({ rows, count: rows.length, ms: res.ms });
      pushToast(t`Query ok · ${rows.length} row(s) · ${res.ms}ms`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
      <div className="flex flex-col gap-2.5">
        <Card className="gap-0 py-0">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
            <I.Database size={13} /><span className="text-xs font-medium"><Trans>Tables</Trans></span>
            <div className="flex-1" />
            <span className="font-mono text-[11px] text-muted-foreground">{filteredTables.length === tables.length ? tables.length : `${filteredTables.length}/${tables.length}`}</span>
          </div>
          <div className="border-t border-border px-2 py-1.5">
            <Input
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              placeholder={t`Filter tables…`}
              spellCheck={false}
            />
          </div>
          <ScrollArea viewportClassName="max-h-[280px]">
            {!tablesLoaded ? (
              // First-load placeholder for the table list.
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 border-t border-border px-3 py-1.5">
                  <Skeleton className="size-3 shrink-0 rounded-sm" />
                  <Skeleton className="h-3.5 flex-1" />
                  <Skeleton className="h-3 w-8" />
                </div>
              ))
            ) : filteredTables.length === 0 ? (
              <EmptyState size="sm" title={tables.length === 0 ? <Trans>This database has no tables.</Trans> : <Trans>No tables match.</Trans>} />
            ) : filteredTables.map((t) => (
              <div key={t.name} title={browseSql(t.name)} className="flex cursor-pointer items-center gap-2 border-t border-border px-3 py-1.5" onClick={() => setSql(browseSql(t.name))}>
                <I.Braces size={11} className="text-muted-foreground" />
                <span className="flex-1 truncate font-mono text-[11.5px]">{t.name}</span>
                <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">{t.rows.toLocaleString()}</span>
              </div>
            ))}
          </ScrollArea>
        </Card>
        <Card className="gap-0 py-0">
          <div className="border-b border-border px-4 py-3.5 text-xs font-medium"><Trans>Snippets</Trans></div>
          <ScrollArea viewportClassName="max-h-[220px]">
            {snippets.length === 0 ? (
              <div className="border-t border-border px-3 py-2.5 text-[11.5px] text-muted-foreground"><Trans>No tables yet.</Trans></div>
            ) : snippets.map((s) => (
              <div key={s.name} title={s.sql} onClick={() => setSql(s.sql)} className="cursor-pointer truncate border-t border-border px-3 py-2 text-xs">{s.name}</div>
            ))}
          </ScrollArea>
        </Card>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <Card className="gap-0 py-0">
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border px-4 py-3.5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="text-xs font-medium">query.sql</span>
              {isWrite && <Badge variant="destructive">WRITE</Badge>}
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11.5px] text-muted-foreground">
                <I.Lock size={11} /> <Trans>read-only</Trans>
                <Switch checked={readOnly} onChange={setReadOnly} />
              </label>
              <Button size="sm" variant="outline" icon={I.Save} onClick={() => pushToast(t`Saved as snippet.`)}><Trans>Save</Trans></Button>
              <Button size="sm" variant="primary" icon={I.Play} disabled={running || (readOnly && isWrite)} onClick={run}>{running ? <Trans>Running…</Trans> : <Trans>Run</Trans>}</Button>
            </div>
          </div>
          <Textarea value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} className="w-full resize-y rounded-none border-0 bg-[oklch(0.18_0.01_130)] p-3.5 font-mono text-[13px] leading-[1.55] text-[oklch(0.92_0.02_130)] outline-0 min-h-[180px]" />
          {readOnly && isWrite && (
            <div className="flex items-center gap-1.5 border-t border-[color-mix(in_oklch,var(--destructive)_35%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_8%,var(--card))] px-3.5 py-2 text-[11.5px] text-destructive">
              <I.AlertTriangle size={12} /> <Trans>Writes blocked. Toggle "read-only" off to run mutations.</Trans>
            </div>
          )}
        </Card>
        <Card className="gap-0 py-0">
          <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-border px-4 py-3.5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="text-xs font-medium"><Trans>Result</Trans></span>
              <span className="font-mono text-[11px] text-muted-foreground">{result.count} <Trans>rows</Trans> · {result.ms}ms</span>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <Button size="sm" variant="ghost" icon={I.Download} onClick={() => pushToast(t`Exported result.csv.`)}>CSV</Button>
              <Button size="sm" variant="ghost" icon={I.Code} onClick={() => pushToast(t`Copied JSON.`)}>JSON</Button>
            </div>
          </div>
          {result.rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12.5px] text-muted-foreground">
              {result.ms > 0 ? <Trans>Query returned no rows.</Trans> : <Trans>Run a query to see results.</Trans>}
            </div>
          ) : (
            <Table className={ADMIN_TABLE_CLS}>
              <TableHeader>
                <TableRow>{Object.keys(result.rows[0] || {}).map((k) => <TableHead key={k}>{k}</TableHead>)}</TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((r, i) => (
                  <TableRow key={i}>
                    {Object.entries(r).map(([k, v]) => <TableCell key={k} className={`font-mono text-xs ${typeof v === "number" ? "tabular-nums" : ""}`}>{String(v)}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

function Migrations({ pushToast }: { pushToast: PushToast }) {
  type Mig = { hash: string; tag: string | null; applied: boolean; t: string };
  const [migs, setMigs] = useState<Mig[]>([]);
  const [active, setActive] = useState<Mig | null>(null);
  useEffect(() => {
    if (active && migs.some((m) => m.hash === active.hash)) return;
    setActive(migs[0] ?? null);
  }, [migs]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await dbAdminApi.migrations();
        if (cancelled || !Array.isArray(r.data) || r.data.length === 0) return;
        const mapped: Mig[] = r.data.map((m) => ({
          hash: String(m.hash ?? m.id),
          tag: m.tag ?? null,
          applied: true,
          t: typeof m.created_at === "number"
            ? new Date(m.created_at).toISOString().replace("T", " ").slice(0, 16)
            : String(m.created_at),
        }));
        setMigs(mapped);
        setActive(mapped[0] ?? null);
      } catch (e) {
        pushToast?.((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [pushToast]);
  return (
    <div className="grid grid-cols-[380px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
      <Card className="gap-0 py-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <span className="text-xs font-medium"><Trans>Migrations</Trans></span>
          <div className="flex-1" />
          <span className="font-mono text-[11px] text-muted-foreground">{migs.length}</span>
        </div>
        {migs.length === 0 && (
          <EmptyState size="sm" title={<Trans>No migrations applied yet.</Trans>} />
        )}
        {migs.map((m) => (
          <div
            key={m.hash}
            onClick={() => setActive(m)}
            className={`grid cursor-pointer grid-cols-[20px_1fr_70px] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0 ${active?.hash === m.hash ? "bg-accent" : ""}`}
          >
            <span><I.Check size={13} className="text-[oklch(0.55_0.16_145)]" /></span>
            <div className="min-w-0">
              <div className="truncate font-mono text-[11.5px]">
                {m.tag ?? m.hash.slice(0, 12)}
              </div>
              <div className="text-[11px] text-muted-foreground">{m.t}</div>
            </div>
            <Badge variant="default"><Trans>applied</Trans></Badge>
          </div>
        ))}
      </Card>
      <Card className="gap-0 py-0">
        {!active ? (
          <div className="p-9 text-center text-[13px] text-muted-foreground"><Trans>Pick a migration to inspect its details.</Trans></div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
              <span className="font-mono text-xs font-medium">{active.tag ?? active.hash.slice(0, 12)}</span>
            </div>
            <div className="flex flex-col gap-2 p-4 text-xs">
              <div><span className="text-muted-foreground"><Trans>Folder tag</Trans></span><div className="font-mono">{active.tag ?? <em className="text-muted-foreground"><Trans>unknown — manifest out of sync, run <code>bun run --cwd packages/db manifest</code></Trans></em>}</div></div>
              <div><span className="text-muted-foreground"><Trans>Hash</Trans></span><div className="font-mono [word-break:break-all]">{active.hash}</div></div>
              <div><span className="text-muted-foreground"><Trans>Applied at</Trans></span><div className="font-mono">{active.t}</div></div>
              <div className="mt-2 text-[11.5px] text-muted-foreground">
                <Trans>Migrations are applied via <code>bun run db:migrate:&lt;dialect&gt;</code> at deploy time. Drizzle tracks them by content hash; the folder tag comes from the build-time manifest. Rollbacks are not supported — write a forward migration instead.</Trans>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function Backups({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  type Backup = { id: string; t: string; size: string; kind: string; tables: number; label: string | undefined };
  const [backups, setBackups] = useState<Backup[]>([]);
  const [schedule, setSchedule] = useState<BackupConfig["schedule"]>("off");
  const [retain, setRetain] = useState(7);
  const [retainDays, setRetainDays] = useState<number | null>(null);
  const [savingCfg, setSavingCfg] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const reload = async () => {
    try {
      const [r, cfg] = await Promise.all([dbAdminApi.backups(), dbAdminApi.backupConfig()]);
      if (Array.isArray(r.data)) {
        setBackups(
          r.data.map((b) => ({
            id: b.id,
            t: new Date(b.createdAt).toISOString().replace("T", " ").slice(0, 16),
            size: b.size > 1_000_000 ? (b.size / 1_000_000).toFixed(0) + " MB" : `${(b.size / 1024).toFixed(1)} KB`,
            kind: b.kind,
            tables: b.tableCount,
            label: b.label ?? undefined,
          })),
        );
      }
      if (cfg.data) {
        setSchedule(cfg.data.schedule);
        setRetain(cfg.data.retain);
        setRetainDays(cfg.data.retainDays ?? null);
      }
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };
  useEffect(() => { void reload(); }, []);
  /**
   * Queue the dump rather than hold the request open for it.
   *
   * The toast has always said "queued"; until the operation moved onto the job
   * queue it was not true — the dump ran inside this request, so a workspace
   * large enough to matter got a spinner and then a gateway timeout. Now the
   * tracking row is written before the call returns (so the list shows it
   * immediately, as `queued`) and the dump happens behind it.
   *
   * The list is then re-read a few times rather than once: the job usually
   * lands within seconds, and an operator who has to press Refresh to find out
   * whether their backup worked will assume it did not.
   */
  const backupNow = async () => {
    try {
      const r = await dbAdminApi.backupNow(undefined, { async: true });
      pushToast(t`Manual backup queued.`);
      await reload();
      const jobId = r.data.jobId;
      if (!jobId) return;
      for (let i = 0; i < 10; i += 1) {
        await new Promise((res) => setTimeout(res, 1500));
        const job = await jobsApi.get(jobId).catch(() => null);
        if (!job) return;
        if (["succeeded", "failed", "dead_letter", "cancelled"].includes(job.status)) {
          await reload();
          if (job.status !== "succeeded") {
            pushToast(job.lastError ?? t`The backup did not finish.`);
          }
          return;
        }
      }
      // Still running after fifteen seconds — a big workspace. Leave the row
      // showing `running` rather than pretending it failed.
      await reload();
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  const saveConfig = async (next: Partial<BackupConfig>) => {
    setSavingCfg(true);
    try {
      const r = await dbAdminApi.saveBackupConfig({ schedule, retain, retainDays, ...next });
      setSchedule(r.data.schedule);
      setRetain(r.data.retain);
      setRetainDays(r.data.retainDays ?? null);
      pushToast(t`Backup schedule saved.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSavingCfg(false);
    }
  };
  // The restore confirm carries a mode switch, so it has to be a real dialog:
  // `window.confirm` cannot hold a control, and the two modes differ by whether
  // the restore can destroy current data.
  const [restoreAsk, setRestoreAsk] = useState<string | null>(null);
  const [restoreOverwrite, setRestoreOverwrite] = useState(false);
  const restore = async (id: string, overwrite: boolean) => {
    setRestoring(id);
    try {
      const r = await dbAdminApi.restoreBackup(id, {
        mode: overwrite ? "overwrite" : "additive",
      });
      // `keptAdditive` is the one result the operator must not miss: they asked
      // for overwrite and part of the dump did not get it.
      if (r.data.keptAdditive.length > 0) {
        pushToast(
          t`Restored ${r.data.rowCount} rows across ${r.data.tableCount} tables. These stayed additive (no single-column id): ${r.data.keptAdditive.join(", ")}`,
        );
      } else {
        pushToast(t`Restored ${r.data.rowCount} rows across ${r.data.tableCount} tables.`);
      }
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setRestoring(null);
    }
  };
  const SCHEDULES: BackupConfig["schedule"][] = ["off", "daily", "weekly"];
  const scheduleLabel: Record<BackupConfig["schedule"], string> = {
    off: t`Off`,
    daily: t`Daily`,
    weekly: t`Weekly`,
  };
  return (
    <div className="flex flex-col gap-3.5">
      <Card className="flex flex-col gap-3 p-3.5">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Automatic schedule</Trans></div>
            <div className="flex gap-1">
              {SCHEDULES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={schedule === s ? "primary" : "ghost"}
                  disabled={savingCfg}
                  onClick={() => { setSchedule(s); void saveConfig({ schedule: s }); }}
                >
                  {scheduleLabel[s]}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Retain (auto)</Trans></div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={365}
                value={String(retain)}
                disabled={schedule === "off" || savingCfg}
                onChange={(e) => setRetain(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
                className="h-8 w-20"
              />
              <Button size="sm" variant="outline" disabled={schedule === "off" || savingCfg} onClick={() => void saveConfig({ retain })}><Trans>Save</Trans></Button>
            </div>
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Prune older than (days)</Trans></div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={3650}
                placeholder={t`off`}
                value={retainDays == null ? "" : String(retainDays)}
                disabled={schedule === "off" || savingCfg}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  setRetainDays(raw === "" ? null : Math.max(1, Math.min(3650, Number(raw) || 1)));
                }}
                className="h-8 w-20"
              />
              <Button size="sm" variant="outline" disabled={schedule === "off" || savingCfg} onClick={() => void saveConfig({ retainDays })}><Trans>Save</Trans></Button>
            </div>
          </div>
        </div>
        <div className="text-[11.5px] text-muted-foreground">
          {retainDays == null
            ? <Trans>Scheduled backups run from the cron tick and keep the newest {retain} automatic dumps. Manual backups are never pruned.</Trans>
            : <Trans>Scheduled backups run from the cron tick and keep the newest {retain} automatic dumps, pruning any older than {retainDays} days. Manual backups are never pruned.</Trans>}
        </div>
      </Card>
      <Card className="gap-0 py-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <span className="text-xs font-medium"><Trans>Backups</Trans></span>
          <div className="flex-1" />
          <Button size="sm" variant="primary" icon={I.Save} onClick={backupNow}><Trans>Back up now</Trans></Button>
        </div>
        <Table className={ADMIN_TABLE_CLS}>
          <TableHeader>
            <TableRow><TableHead>ID</TableHead><TableHead><Trans>Created</Trans></TableHead><TableHead><Trans>Tables</Trans></TableHead><TableHead><Trans>Size</Trans></TableHead><TableHead><Trans>Kind</Trans></TableHead><TableHead className="sticky right-0 bg-card" /></TableRow>
          </TableHeader>
          <TableBody>
            {backups.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-mono text-xs">{b.id}{b.label && <span className="text-muted-foreground"> · {b.label}</span>}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{b.t}</TableCell>
                <TableCell className="tabular-nums">{b.tables}</TableCell>
                <TableCell className="tabular-nums">{b.size}</TableCell>
                <TableCell><Badge variant={b.kind === "auto" ? "secondary" : "default"}>{b.kind}</Badge></TableCell>
                <TableCell className="sticky right-0 bg-card text-right">
                  <Button size="sm" variant="ghost" icon={I.Download} onClick={() => {
                    const url = `/api/admin/db/backups/${b.id}/download`;
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                  }}><Trans>Download</Trans></Button>
                  <Button size="sm" variant="ghost" icon={I.History} disabled={restoring === b.id} onClick={() => { setRestoreOverwrite(false); setRestoreAsk(b.id); }}><Trans>Restore</Trans></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <ConfirmDialog
        open={restoreAsk !== null}
        title={t`Restore from this backup?`}
        destructive={restoreOverwrite}
        actionLabel={restoreOverwrite ? t`Overwrite and restore` : t`Restore`}
        description={
          <span className="flex flex-col gap-3">
            <span>
              {restoreOverwrite ? (
                <Trans>
                  Rows that still exist will be replaced by their values from this
                  backup. Anything changed since it was taken is lost. This is how
                  you undo a bad write.
                </Trans>
              ) : (
                <Trans>
                  Missing rows are re-inserted. Rows that still exist are never
                  overwritten or deleted, so this is safe to run against live data.
                </Trans>
              )}
            </span>
            <span className="flex items-center gap-2">
              <Switch
                checked={restoreOverwrite}
                onChange={(v) => setRestoreOverwrite(v)}
              />
              <span className="text-[13px]"><Trans>Overwrite existing rows</Trans></span>
            </span>
          </span>
        }
        onCancel={() => setRestoreAsk(null)}
        onConfirm={() => {
          const id = restoreAsk;
          setRestoreAsk(null);
          if (id) void restore(id, restoreOverwrite);
        }}
      />
    </div>
  );
}
