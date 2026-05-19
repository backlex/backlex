// @ts-nocheck
import { useEffect, useMemo, useState } from "react";
import { I } from "../icons";
import { ADAPTER_PROFILES, type AdapterId } from "../config";
import { Badge, Button, PageHeader, Switch } from "../ui";
import { dbAdminApi } from "../api";

export function DatabasePage({ pushToast, adapter }: { pushToast: (m: string) => void; adapter: AdapterId }) {
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
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Database"
        description={<>Direct access to the underlying engine. Adapter: <span className="font-mono">{ADAPTER_PROFILES[adapter].db}</span>. SQL editor runs through the same permission layer as the API.</>}
        badges={<Badge variant="outline" mono>{ADAPTER_PROFILES[adapter].db}</Badge>}
      />
      <div className="tabs">
        <button className="tab" data-active={tab === "sql"} onClick={() => setTab("sql")}><I.Code size={13} />SQL editor</button>
        <button className="tab" data-active={tab === "migrations"} onClick={() => setTab("migrations")}>
          <I.History size={13} />Migrations
          {migCount !== null && <span className="count">{migCount}</span>}
        </button>
        <button className="tab" data-active={tab === "backups"} onClick={() => setTab("backups")}>
          <I.Save size={13} />Backups
          {backupCount !== null && <span className="count">{backupCount}</span>}
        </button>
      </div>
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
  const [sql, setSql] = useState("SELECT 1;");
  const [result, setResult] = useState<{ rows: Record<string, unknown>[]; ms: number; count: number }>({
    rows: [],
    ms: 0,
    count: 0,
  });
  const [running, setRunning] = useState(false);
  const [readOnly, setReadOnly] = useState(true);

  const [tables, setTables] = useState<{ name: string; rows: number }[]>([]);
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
      pushToast(`Query ok · ${rows.length} row(s) · ${res.ms}ms`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="master-detail" style={{ "--md-aside": "240px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="card">
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <I.Database size={13} /><span style={{ fontSize: 12, fontWeight: 500 }}>Tables</span>
            <div className="spacer" />
            <span className="muted font-mono" style={{ fontSize: 11 }}>{filteredTables.length === tables.length ? tables.length : `${filteredTables.length}/${tables.length}`}</span>
          </div>
          <div style={{ padding: "6px 8px", borderTop: "1px solid var(--border)" }}>
            <input
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              placeholder="Filter tables…"
              spellCheck={false}
              style={{ width: "100%", padding: "5px 10px", fontSize: 11.5, borderRadius: "var(--radius-3xl)", border: "1px solid var(--border)", background: "var(--background)", color: "inherit", outline: 0 }}
            />
          </div>
          <div className="scrollarea" style={{ maxHeight: 280, overflowY: "auto" }}>
            {filteredTables.length === 0 ? (
              <div className="muted" style={{ padding: "12px", fontSize: 11.5, textAlign: "center" }}>
                {tables.length === 0 ? "Loading…" : "No tables match."}
              </div>
            ) : filteredTables.map((t) => (
              <div key={t.name} title={browseSql(t.name)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderTop: "1px solid var(--border)", cursor: "pointer" }} onClick={() => setSql(browseSql(t.name))}>
                <I.Braces size={11} className="muted" />
                <span className="font-mono" style={{ fontSize: 11.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                <span className="muted tabular-nums" style={{ fontSize: 10.5 }}>{t.rows.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-section" style={{ fontSize: 12, fontWeight: 500 }}>Snippets</div>
          <div className="scrollarea" style={{ maxHeight: 220, overflowY: "auto" }}>
            {snippets.length === 0 ? (
              <div className="muted" style={{ padding: "10px 12px", fontSize: 11.5, borderTop: "1px solid var(--border)" }}>No tables yet.</div>
            ) : snippets.map((s) => (
              <div key={s.name} title={s.sql} onClick={() => setSql(s.sql)} style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", cursor: "pointer", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 500 }}>query.sql</span>
            {isWrite && <Badge variant="destructive">WRITE</Badge>}
            <div className="spacer" />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--muted-foreground)" }}>
              <I.Lock size={11} /> read-only
              <Switch checked={readOnly} onChange={setReadOnly} />
            </label>
            <Button size="sm" variant="outline" icon={I.Save} onClick={() => pushToast("Saved as snippet.")}>Save</Button>
            <Button size="sm" variant="primary" icon={I.Play} disabled={running || (readOnly && isWrite)} onClick={run}>{running ? "Running…" : "Run"}</Button>
          </div>
          <textarea value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} style={{ width: "100%", minHeight: 180, padding: 14, border: 0, outline: 0, resize: "vertical", background: "oklch(0.18 0.01 130)", color: "oklch(0.92 0.02 130)", fontFamily: "Geist Mono, monospace", fontSize: 13, lineHeight: 1.55 }} />
          {readOnly && isWrite && (
            <div style={{ padding: "8px 14px", background: "color-mix(in oklch, var(--destructive) 8%, var(--card))", borderTop: "1px solid color-mix(in oklch, var(--destructive) 35%, var(--border))", fontSize: 11.5, color: "var(--destructive)", display: "flex", alignItems: "center", gap: 6 }}>
              <I.AlertTriangle size={12} /> Writes blocked. Toggle "read-only" off to run mutations.
            </div>
          )}
        </div>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 500 }}>Result</span>
            <span className="muted font-mono" style={{ fontSize: 11 }}>{result.count} rows · {result.ms}ms</span>
            <div className="spacer" />
            <Button size="sm" variant="ghost" icon={I.Download} onClick={() => pushToast("Exported result.csv.")}>CSV</Button>
            <Button size="sm" variant="ghost" icon={I.Code} onClick={() => pushToast("Copied JSON.")}>JSON</Button>
          </div>
          {result.rows.length === 0 ? (
            <div className="muted" style={{ padding: "24px 16px", fontSize: 12.5, textAlign: "center" }}>
              {result.ms > 0 ? "Query returned no rows." : "Run a query to see results."}
            </div>
          ) : (
            <div className="table-scroll">
            <table className="table">
              <thead><tr>{Object.keys(result.rows[0] || {}).map((k) => <th key={k}>{k}</th>)}</tr></thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr key={i}>
                    {Object.entries(r).map(([k, v]) => <td key={k} className={typeof v === "number" ? "tabular-nums font-mono" : "font-mono"} style={{ fontSize: 12 }}>{String(v)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
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
    <div className="master-detail" style={{ "--md-aside": "380px" }}>
      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>Migrations</span>
          <div className="spacer" />
          <span className="muted font-mono" style={{ fontSize: 11 }}>{migs.length}</span>
        </div>
        {migs.length === 0 && (
          <div className="muted" style={{ padding: "16px 12px", fontSize: 12 }}>No migrations applied yet.</div>
        )}
        {migs.map((m) => (
          <div key={m.hash} onClick={() => setActive(m)} className="schema-row" style={{ gridTemplateColumns: "20px 1fr 70px", cursor: "pointer", background: active?.hash === m.hash ? "var(--accent)" : "transparent" }}>
            <span><I.Check size={13} style={{ color: "oklch(0.55 0.16 145)" }} /></span>
            <div style={{ minWidth: 0 }}>
              <div className="font-mono" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.tag ?? m.hash.slice(0, 12)}
              </div>
              <div className="muted" style={{ fontSize: 11 }}>{m.t}</div>
            </div>
            <Badge variant="default">applied</Badge>
          </div>
        ))}
      </div>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {!active ? (
          <div className="muted" style={{ padding: 36, textAlign: "center", fontSize: 13 }}>Pick a migration to inspect its details.</div>
        ) : (
          <>
            <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="font-mono" style={{ fontSize: 12, fontWeight: 500 }}>{active.tag ?? active.hash.slice(0, 12)}</span>
            </div>
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
              <div><span className="muted">Folder tag</span><div className="font-mono">{active.tag ?? <em className="muted">unknown — manifest out of sync, run <code>bun run --cwd packages/db manifest</code></em>}</div></div>
              <div><span className="muted">Hash</span><div className="font-mono" style={{ wordBreak: "break-all" }}>{active.hash}</div></div>
              <div><span className="muted">Applied at</span><div className="font-mono">{active.t}</div></div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
                Migrations are applied via <code>bun run db:migrate:&lt;dialect&gt;</code> at deploy time. Drizzle tracks them by content hash; the folder tag comes from the build-time manifest. Rollbacks are not supported — write a forward migration instead.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Backups({ pushToast }: { pushToast: (m: string) => void }) {
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
      pushToast("Manual backup queued.");
      await reload();
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="card cols-3" style={{ padding: 14 }}>
        <div><div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Schedule</div><div style={{ fontWeight: 500 }}>Daily 03:00 UTC</div></div>
        <div><div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Retention</div><div style={{ fontWeight: 500 }}>30 days</div></div>
        <div><div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>Destination</div><div className="font-mono" style={{ fontWeight: 500, fontSize: 12 }}>r2://workeros-backups/</div></div>
      </div>
      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>Backups</span>
          <div className="spacer" />
          <Button size="sm" variant="primary" icon={I.Save} onClick={backupNow}>Back up now</Button>
        </div>
        <div className="table-scroll">
        <table className="table">
          <thead><tr><th>ID</th><th>Created</th><th>Tables</th><th>Size</th><th>Kind</th><th className="col-actions"></th></tr></thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.id}>
                <td className="font-mono" style={{ fontSize: 12 }}>{b.id}{b.label && <span className="muted"> · {b.label}</span>}</td>
                <td className="muted font-mono" style={{ fontSize: 11.5 }}>{b.t}</td>
                <td className="tabular-nums">{b.tables}</td>
                <td className="tabular-nums">{b.size}</td>
                <td><Badge variant={b.kind === "auto" ? "secondary" : "default"}>{b.kind}</Badge></td>
                <td className="col-actions" style={{ textAlign: "right" }}>
                  <Button size="sm" variant="ghost" icon={I.Download} onClick={() => {
                    const url = `/api/admin/db/backups/${b.id}/download`;
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                  }}>Download</Button>
                  <Button size="sm" variant="ghost" icon={I.History} onClick={() => pushToast(`Restored from ${b.id} (dry-run).`)}>Restore</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
