// @ts-nocheck
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { ADAPTER_PROFILES, type AdapterId } from "../config";
import { Badge, Button, EmptyState, PageHeader, Switch } from "../ui";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { dbAdminApi } from "../api";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

export function DatabasePage({ pushToast, adapter }: { pushToast: (m: string) => void; adapter: AdapterId }) {
  const { t } = useLingui();
  const [tab, setTab] = useState("sql");
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
      <Tabs value={tab} onValueChange={setTab}>
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

function SqlEditor({ pushToast }: { pushToast: (m: string) => void }) {
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
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
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
                  <Skeleton className="size-3 shrink-0 rounded" />
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
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          <div className="border-b border-border px-4 py-3.5 text-xs font-medium"><Trans>Snippets</Trans></div>
          <ScrollArea viewportClassName="max-h-[220px]">
            {snippets.length === 0 ? (
              <div className="border-t border-border px-3 py-2.5 text-[11.5px] text-muted-foreground"><Trans>No tables yet.</Trans></div>
            ) : snippets.map((s) => (
              <div key={s.name} title={s.sql} onClick={() => setSql(s.sql)} className="cursor-pointer truncate border-t border-border px-3 py-2 text-xs">{s.name}</div>
            ))}
          </ScrollArea>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
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
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
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
        </div>
      </div>
    </div>
  );
}

function Migrations({ pushToast }: { pushToast: (m: string) => void }) {
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
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
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
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
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
      </div>
    </div>
  );
}

function Backups({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  type Backup = { id: string; t: string; size: string; kind: string; tables: number; label: string | undefined };
  const [backups, setBackups] = useState<Backup[]>([]);
  const reload = async () => {
    try {
      const r = await dbAdminApi.backups();
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
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const backupNow = async () => {
    try {
      await dbAdminApi.backupNow();
      pushToast(t`Manual backup queued.`);
      await reload();
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid grid-cols-3 gap-3 overflow-hidden rounded-2xl border border-border bg-card p-3.5 text-card-foreground max-[640px]:grid-cols-1">
        <div><div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Schedule</Trans></div><div className="font-medium"><Trans>Daily 03:00 UTC</Trans></div></div>
        <div><div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Retention</Trans></div><div className="font-medium"><Trans>30 days</Trans></div></div>
        <div><div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><Trans>Destination</Trans></div><div className="font-mono text-xs font-medium">r2://backlex-backups/</div></div>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
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
                  <Button size="sm" variant="ghost" icon={I.History} onClick={() => pushToast(t`Restored from ${b.id} (dry-run).`)}><Trans>Restore</Trans></Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
