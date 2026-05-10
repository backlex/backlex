// @ts-nocheck
// directus/supabase parity pages — Database, Auth, Activity, Revisions, Insights, Email, Translations
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { I } from "./icons";
import { MOCK, type AdapterId } from "./mock";
import { Badge, Button, IconButton, PageHeader, Switch } from "./ui";
import { Select } from "./select";
import {
  activityApi,
  authAdminApi,
  dbAdminApi,
  emailTemplatesApi,
  i18nApi,
  panelsApi,
  type ApiActivity,
  type ApiAuthConfig,
  type ApiEmailTemplate,
  type ApiPanel,
  type ApiSession,
} from "./api";

const fmtRelative = (iso: string | null): string => {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
};

export function DatabasePage({ pushToast, adapter }: { pushToast: (m: string) => void; adapter: AdapterId }) {
  const [tab, setTab] = useState("sql");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Database"
        description={<>Direct access to the underlying engine. Adapter: <span className="font-mono">{MOCK.adapterProfiles[adapter].db}</span>. SQL editor runs through the same permission layer as the API.</>}
        badges={<Badge variant="outline" mono>{MOCK.adapterProfiles[adapter].db}</Badge>}
      />
      <div className="tabs">
        <button className="tab" data-active={tab === "sql"} onClick={() => setTab("sql")}><I.Code size={13} />SQL editor</button>
        <button className="tab" data-active={tab === "migrations"} onClick={() => setTab("migrations")}><I.History size={13} />Migrations <span className="count">12</span></button>
        <button className="tab" data-active={tab === "backups"} onClick={() => setTab("backups")}><I.Save size={13} />Backups <span className="count">8</span></button>
      </div>
      {tab === "sql" && <SqlEditor pushToast={pushToast} />}
      {tab === "migrations" && <Migrations pushToast={pushToast} />}
      {tab === "backups" && <Backups pushToast={pushToast} />}
    </div>
  );
}

function SqlEditor({ pushToast }: { pushToast: (m: string) => void }) {
  const snippets = [
    { name: "Recent posts", sql: "SELECT id, title, status, view_count\nFROM c_posts\nORDER BY updated_at DESC\nLIMIT 20;" },
    { name: "Top authors", sql: "SELECT author, count(*) as posts\nFROM c_posts\nGROUP BY author\nORDER BY posts DESC;" },
    { name: "Storage size", sql: "SELECT folder, count(*), sum(size) as bytes\nFROM storage_objects\nGROUP BY folder;" },
    { name: "Active sessions", sql: "SELECT user_id, count(*)\nFROM auth_sessions\nWHERE expires_at > now()\nGROUP BY user_id;" },
  ];
  const [sql, setSql] = useState(snippets[0].sql);
  const [result, setResult] = useState<{ rows: Record<string, unknown>[]; ms: number; count: number }>({
    rows: [],
    ms: 0,
    count: 0,
  });
  const [running, setRunning] = useState(false);
  const [readOnly, setReadOnly] = useState(true);

  // Live table list: query sqlite_master once on mount, fall back to mock
  // names if the call fails (e.g. unauthenticated dev preview).
  const seedTables = [
    { name: "c_posts", rows: 0 },
    { name: "users", rows: 0 },
    { name: "sessions", rows: 0 },
  ];
  const [tables, setTables] = useState(seedTables);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await dbAdminApi.runSql(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_drizzle%' ESCAPE '\\' ORDER BY name;",
        );
        if (cancelled) return;
        const names = (r.data?.[0]?.rows ?? []) as { name: string }[];
        if (!Array.isArray(names) || names.length === 0) return;
        // Best-effort row count per table — small DB so we run a COUNT per
        // table in parallel; cap at 50 tables to keep the panel snappy.
        const limited = names.slice(0, 50);
        const counts = await Promise.allSettled(
          limited.map(async (t) => {
            const c = await dbAdminApi.runSql(`SELECT COUNT(*) AS n FROM "${t.name}";`);
            const row = (c.data?.[0]?.rows?.[0] ?? {}) as { n?: number };
            return { name: t.name, rows: Number(row.n ?? 0) };
          }),
        );
        if (cancelled) return;
        setTables(
          counts.map((c, i) =>
            c.status === "fulfilled" ? c.value : { name: limited[i]!.name, rows: 0 },
          ),
        );
      } catch {
        // keep seed
      }
    })();
    return () => { cancelled = true; };
  }, []);

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
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 14, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="card">
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <I.Database size={13} /><span style={{ fontSize: 12, fontWeight: 500 }}>Tables</span>
            <div className="spacer" />
            <span className="muted font-mono" style={{ fontSize: 11 }}>{tables.length}</span>
          </div>
          {tables.map((t) => (
            <div key={t.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderTop: "1px solid var(--border)", cursor: "pointer" }} onClick={() => setSql(`SELECT * FROM ${t.name} LIMIT 50;`)}>
              <I.Braces size={11} className="muted" />
              <span className="font-mono" style={{ fontSize: 11.5, flex: 1 }}>{t.name}</span>
              <span className="muted tabular-nums" style={{ fontSize: 10.5 }}>{t.rows.toLocaleString()}</span>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="card-section" style={{ fontSize: 12, fontWeight: 500 }}>Snippets</div>
          {snippets.map((s) => (
            <div key={s.name} onClick={() => setSql(s.sql)} style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", cursor: "pointer", fontSize: 12 }}>{s.name}</div>
          ))}
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
          )}
        </div>
      </div>
    </div>
  );
}

function Migrations({ pushToast }: { pushToast: (m: string) => void }) {
  const seedMigs = [
    { id: "20260506_142210_add_reading_time", applied: true, t: "2026-05-06 14:22", author: "rana", sql: "ALTER TABLE c_posts ADD COLUMN reading_time_minutes INTEGER NOT NULL DEFAULT 0;" },
    { id: "20260504_103105_index_published_at", applied: true, t: "2026-05-04 10:31", author: "kai", sql: "CREATE INDEX c_posts_published_at_idx ON c_posts (published_at DESC);" },
  ];
  const [migs, setMigs] = useState(seedMigs);
  const [active, setActive] = useState(seedMigs[0]!);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await dbAdminApi.migrations();
        if (cancelled || !Array.isArray(r.data) || r.data.length === 0) return;
        const mapped = r.data.map((m) => ({
          id: String(m.hash ?? m.id),
          applied: true,
          t: typeof m.created_at === "number"
            ? new Date(m.created_at).toISOString().replace("T", " ").slice(0, 16)
            : String(m.created_at),
          author: "system",
          sql: "",
        }));
        setMigs(mapped);
        setActive(mapped[0]!);
      } catch (e) {
        pushToast?.((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [pushToast]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: 14, alignItems: "start" }}>
      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 500 }}>Migrations</span>
          <div className="spacer" />
          <Button size="sm" variant="primary" icon={I.Plus} onClick={() => pushToast("New migration drafted.")}>New</Button>
        </div>
        {migs.map((m) => (
          <div key={m.id} onClick={() => setActive(m)} className="schema-row" style={{ gridTemplateColumns: "20px 1fr 70px", cursor: "pointer", background: active.id === m.id ? "var(--accent)" : "transparent" }}>
            <span>{m.applied ? <I.Check size={13} style={{ color: "oklch(0.55 0.16 145)" }} /> : <I.Clock size={13} className="muted" />}</span>
            <div style={{ minWidth: 0 }}>
              <div className="font-mono" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.id}</div>
              <div className="muted" style={{ fontSize: 11 }}>{m.t} · {m.author}</div>
            </div>
            <Badge variant={m.applied ? "default" : "secondary"}>{m.applied ? "applied" : "pending"}</Badge>
          </div>
        ))}
      </div>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="font-mono" style={{ fontSize: 12, fontWeight: 500 }}>{active.id}</span>
          <div className="spacer" />
          {!active.applied && <Button size="sm" variant="primary" icon={I.Play} onClick={() => pushToast(`Applied ${active.id}.`)}>Apply</Button>}
          {active.applied && <Button size="sm" variant="outline" icon={I.History} onClick={() => pushToast("Rollback queued.")}>Rollback</Button>}
        </div>
        <div className="alter-preview" style={{ borderRadius: 0, border: 0, fontSize: 12, padding: 16, minHeight: 140 }}>{active.sql || "-- this migration has been collapsed; see source repo"}</div>
      </div>
    </div>
  );
}

function Backups({ pushToast }: { pushToast: (m: string) => void }) {
  const seed = [
    { id: "bk_20260506", t: "2026-05-06 03:00", size: "184 MB", kind: "auto", tables: 14, label: undefined as string | undefined },
    { id: "bk_20260503_pre_drop", t: "2026-05-03 18:42", size: "180 MB", kind: "manual", tables: 14, label: "pre-drop-legacy-meta" },
  ];
  const [backups, setBackups] = useState(seed);
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
      <div className="card" style={{ padding: 14, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
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
        <table className="table">
          <thead><tr><th>ID</th><th>Created</th><th>Tables</th><th>Size</th><th>Kind</th><th></th></tr></thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.id}>
                <td className="font-mono" style={{ fontSize: 12 }}>{b.id}{b.label && <span className="muted"> · {b.label}</span>}</td>
                <td className="muted font-mono" style={{ fontSize: 11.5 }}>{b.t}</td>
                <td className="tabular-nums">{b.tables}</td>
                <td className="tabular-nums">{b.size}</td>
                <td><Badge variant={b.kind === "auto" ? "secondary" : "default"}>{b.kind}</Badge></td>
                <td style={{ textAlign: "right" }}>
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
  );
}

export function AuthSettingsPage({ pushToast }: { pushToast: (m: string) => void }) {
  type ProviderRow = { id: string; name: string; enabled: boolean; configured: boolean; system?: boolean; clientId?: string | null };
  // Pretty names — we keep this map purely for label rendering; the actual
  // list of providers comes from /api/admin/auth/config so unsupported
  // providers don't appear in the UI on a fresh deploy.
  const PROVIDER_NAMES: Record<string, string> = {
    email: "Email + password",
    magic: "Magic link",
    github: "GitHub",
    google: "Google",
    apple: "Apple",
    microsoft: "Microsoft",
    discord: "Discord",
    passkey: "Passkeys (WebAuthn)",
  };
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [sessions, setSessions] = useState<{ id: string; user: string; device: string; ip: string; loc: string; created: string; last: string; current: boolean }[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await authAdminApi.config();
        if (cancelled) return;
        const data = cfg.data as ApiAuthConfig;
        const map = (data?.providers ?? {}) as Record<string, { enabled?: boolean; configured?: boolean; clientId?: string | null; system?: boolean }>;
        const rows: ProviderRow[] = Object.entries(map).map(([id, v]) => ({
          id,
          name: PROVIDER_NAMES[id] ?? id,
          enabled: !!v.enabled,
          configured: !!v.configured,
          system: !!v.system,
          clientId: v.clientId ?? null,
        }));
        // Stable order: built-ins first, then alphabetical.
        rows.sort((a, b) => {
          if (a.system !== b.system) return a.system ? -1 : 1;
          return a.id.localeCompare(b.id);
        });
        setProviders(rows);
      } catch {
        // leave empty — the list always reflects what the worker actually has
      }
      try {
        const ss = await authAdminApi.sessions();
        if (cancelled) return;
        setSessions(
          ss.data.map((s: ApiSession) => ({
            id: s.id,
            user: s.userEmail,
            device: (s.userAgent ?? "unknown agent").slice(0, 40),
            ip: s.ipAddress ?? "—",
            loc: "—",
            created: new Date(s.createdAt).toISOString().replace("T", " ").slice(0, 19),
            last: fmtRelative(s.createdAt),
            current: false,
          })),
        );
      } catch (e) {
        pushToast?.((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [pushToast]);

  const toggleProvider = async (id: string, enabled: boolean) => {
    setProviders((arr) => arr.map((p) => (p.id === id ? { ...p, enabled } : p)));
    try {
      const all = providers.map((p) =>
        p.id === id ? { ...p, enabled } : p,
      );
      const obj: Record<string, { enabled: boolean; configured: boolean; clientId?: string | null }> = {};
      for (const p of all)
        obj[p.id] = { enabled: p.enabled, configured: p.configured, clientId: p.clientId };
      await authAdminApi.patch({ providers: obj });
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const revokeSession = async (id: string) => {
    try {
      await authAdminApi.revokeSession(id);
      setSessions((arr) => arr.filter((s) => s.id !== id));
      pushToast?.(`Session ${id.slice(0, 6)}… revoked.`);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };
  const revokeOthers = async () => {
    try {
      const r = await authAdminApi.revokeOthers();
      pushToast?.(`Revoked ${r.removed} other session(s).`);
      const ss = await authAdminApi.sessions();
      setSessions(
        ss.data.map((s: ApiSession) => ({
          id: s.id,
          user: s.userEmail,
          device: (s.userAgent ?? "unknown agent").slice(0, 40),
          ip: s.ipAddress ?? "—",
          loc: "—",
          created: new Date(s.createdAt).toISOString().replace("T", " ").slice(0, 19),
          last: fmtRelative(s.createdAt),
          current: false,
        })),
      );
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader title="Authentication" description={<>Configure sign-in methods, MFA, and session policy. Tokens are signed with <span className="font-mono">$AUTH_SECRET</span>.</>} />
      <div className="split">
        <div className="card">
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Providers</span>
            <div className="spacer" />
            <Button size="sm" variant="outline" icon={I.Plus} onClick={() => pushToast("Add custom OIDC provider.")}>Add</Button>
          </div>
          {providers.map((p) => (
            <div key={p.id} className="schema-row" style={{ gridTemplateColumns: "24px 1fr auto auto auto" }}>
              <span><I.Shield size={13} /></span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</div>
                {p.clientId && <div className="font-mono muted" style={{ fontSize: 11 }}>{p.clientId}</div>}
                {p.system && <div className="muted" style={{ fontSize: 11 }}>built-in</div>}
              </div>
              {!p.configured && <Badge variant="secondary">not configured</Badge>}
              <Button size="sm" variant="ghost" onClick={() => pushToast(`${p.name} settings.`)}>Configure</Button>
              <Switch checked={p.enabled} onChange={(v) => toggleProvider(p.id, v)} />
            </div>
          ))}
        </div>
        <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Policy</span>
          {(() => {
            const persist = async (key: string, on: boolean) => {
              try {
                const cur = await authAdminApi.config();
                const policy = { ...(cur.data?.policy ?? {}), [key]: on };
                await authAdminApi.patch({ policy });
              } catch (e) {
                pushToast?.((e as Error).message);
              }
            };
            return <>
              <PolicyRow label="Require email verification" desc="Users must confirm their email before sign-in." defaultOn policyKey="requireEmailVerification" onPersist={persist} />
              <PolicyRow label="Multi-factor (TOTP)" desc="Users can enroll an authenticator app." defaultOn policyKey="mfaTotp" onPersist={persist} />
              <PolicyRow label="Multi-factor required for admins" desc="Force admins to enroll MFA." policyKey="mfaRequiredForAdmins" onPersist={persist} />
              <PolicyRow label="Passkeys" desc="WebAuthn-based passwordless sign-in." defaultOn policyKey="passkeys" onPersist={persist} />
              <PolicyRow label="Open sign-up" desc="Anyone can create an account." defaultOn policyKey="openSignup" onPersist={persist} />
            </>;
          })()}
          <div className="field" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <label className="field-label">Session lifetime</label>
            <Select value="30d" onChange={() => {}} options={["1h", "24h", "7d", "30d", "90d"]} />
          </div>
          <div className="field">
            <label className="field-label">Allowed redirect URLs</label>
            <textarea className="input" rows={3} defaultValue={"https://workeros.dev/auth/callback\nhttp://localhost:3000/auth/callback"} style={{ height: "auto", fontFamily: "Geist Mono, monospace", fontSize: 12 }} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.Activity size={13} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Active sessions</span>
          <span className="muted font-mono" style={{ fontSize: 11.5 }}>{sessions.length} sessions · {new Set(sessions.map((s) => s.user)).size} users</span>
          <div className="spacer" />
          <Button size="sm" variant="outline" icon={I.LogOut} onClick={revokeOthers}>Revoke others</Button>
        </div>
        <table className="table">
          <thead><tr><th>User</th><th>Device</th><th>Location</th><th>IP</th><th>Created</th><th>Last seen</th><th></th></tr></thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{s.user}{s.current && <Badge variant="default" style={{ marginLeft: 6 }}>current</Badge>}</td>
                <td className="font-mono" style={{ fontSize: 11.5 }}>{s.device}</td>
                <td>{s.loc}</td>
                <td className="font-mono muted" style={{ fontSize: 11.5 }}>{s.ip}</td>
                <td className="muted font-mono" style={{ fontSize: 11.5 }}>{s.created}</td>
                <td className="muted font-mono" style={{ fontSize: 11.5 }}>{s.last}</td>
                <td style={{ textAlign: "right" }}>{!s.current && <Button size="sm" variant="ghost" onClick={() => void revokeSession(s.id)}>Revoke</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PolicyRow({ label, desc, defaultOn, policyKey, onPersist }: { label: string; desc: string; defaultOn?: boolean; policyKey?: string; onPersist?: (key: string, on: boolean) => void }) {
  const [on, setOn] = useState(!!defaultOn);
  return (
    <div className="field-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <div>
        <div className="field-label">{label}</div>
        <div className="field-hint">{desc}</div>
      </div>
      <Switch checked={on} onChange={(v) => {
        setOn(v);
        if (policyKey && onPersist) onPersist(policyKey, v);
      }} />
    </div>
  );
}

export function ActivityPage({ pushToast }: { pushToast: (m: string) => void }) {
  const seed = [
    { t: "2026-05-06 14:23:11", actor: "rana@workeros.dev", action: "item.update", resource: "c_posts/01HZ7K8M9NPQ", diff: '{ status: "review" → "published" }', ip: "192.168.1.4" },
    { t: "2026-05-06 14:22:58", actor: "kai@workeros.dev", action: "item.create", resource: "c_comments/01HZ8R…", diff: "+ 1 row", ip: "85.96.x.x" },
    { t: "2026-05-06 14:21:40", actor: "system", action: "flow.run", resource: "fl_2 (re-index)", diff: "ok · 184ms", ip: "—" },
  ];
  const [events, setEvents] = useState(seed);
  const [filter, setFilter] = useState("all");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await activityApi.list();
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          setEvents(
            res.data.map((a) => ({
              t: new Date(a.createdAt).toISOString().replace("T", " ").slice(0, 19),
              actor: a.userId ?? "system",
              action: a.action,
              resource: `${a.collection}${a.itemId ? "/" + a.itemId : ""}`,
              diff: typeof a.payload === "string" ? a.payload : JSON.stringify(a.payload ?? {}).slice(0, 80),
              ip: a.ip ?? "—",
            })),
          );
        }
      } catch (e) {
        pushToast?.((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [pushToast]);
  const visible = filter === "all" ? events : events.filter((e) => e.action.startsWith(filter));
  const actionColor = (a: string) => a.startsWith("item.") ? "default" as const : a.startsWith("auth.") ? "secondary" as const : a.startsWith("schema.") ? "destructive" as const : "outline" as const;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader title="Activity log" description="Append-only audit trail. Every mutation through the API or UI is logged with actor, IP, and diff." actions={<Button variant="outline" icon={I.Download} onClick={() => {
        const header = "time,actor,action,resource,diff,ip";
        const escape = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
        const body = events
          .map((e) => [e.t, e.actor, e.action, e.resource, e.diff, e.ip].map(escape).join(","))
          .join("\n");
        const blob = new Blob([header + "\n" + body], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "activity.csv"; a.click();
        URL.revokeObjectURL(url);
        pushToast("Exported as activity.csv.");
      }}>Export</Button>} />
      <div className="filter-bar">
        {["all", "item", "auth", "schema", "role", "storage", "flow", "webhook", "backup"].map((k) => (
          <button key={k} className={`chip ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>{k} <span className="muted tabular-nums">{k === "all" ? events.length : events.filter((e) => e.action.startsWith(k)).length}</span></button>
        ))}
      </div>
      <div className="card">
        <table className="table">
          <thead><tr><th style={{ width: 160 }}>Time</th><th style={{ width: 200 }}>Actor</th><th style={{ width: 140 }}>Action</th><th>Resource</th><th>Diff</th><th style={{ width: 130 }}>IP</th></tr></thead>
          <tbody>
            {visible.map((e, i) => (
              <tr key={i}>
                <td className="font-mono muted tabular-nums" style={{ fontSize: 11.5 }}>{e.t}</td>
                <td>{e.actor}</td>
                <td><Badge variant={actionColor(e.action)} mono>{e.action}</Badge></td>
                <td className="font-mono" style={{ fontSize: 12 }}>{e.resource}</td>
                <td className="font-mono muted" style={{ fontSize: 11.5 }}>{e.diff}</td>
                <td className="font-mono muted" style={{ fontSize: 11.5 }}>{e.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RevisionsPage() {
  const items = MOCK.initialPosts.slice(0, 6);
  const [activeId, setActiveId] = useState(items[0].id);
  const item = items.find((x) => x.id === activeId);
  const seedRevs = [
    { v: 6, t: "2026-05-06 14:23", author: "rana", label: "published", changes: [["status", "review", "published"]] },
    { v: 5, t: "2026-05-05 10:41", author: "kai", label: "edit", changes: [["title", "Edge functions are GA", "Edge functions are now generally available"]] },
    { v: 1, t: "2026-05-03 22:14", author: "rana", label: "created", changes: [] },
  ];
  const [revs, setRevs] = useState(seedRevs);
  const [activeRev, setActiveRev] = useState<typeof seedRevs[number] | null>(seedRevs[0] ?? null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Backend `/api/revisions` returns a flat list; filter client-side
        // to the active item. Versioning here is just an index — the design
        // shows monotonic v# labels so we synthesize them from the count.
        const r = await fetch(`/api/revisions/posts/${encodeURIComponent(activeId)}`, { credentials: "include" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { data?: any[] };
        if (Array.isArray(j.data) && j.data.length > 0) {
          const mapped = j.data.map((row, i) => ({
            v: j.data!.length - i,
            t: new Date(row.createdAt).toISOString().slice(0, 16).replace("T", " "),
            author: row.createdBy ?? "system",
            label: i === 0 ? "current" : "edit",
            changes: row.snapshot ? Object.entries(row.snapshot).slice(0, 4).map(([k, v]) => [k, "—", v]) : [],
          }));
          setRevs(mapped);
          setActiveRev(mapped[0] ?? null);
        } else if (Array.isArray(j.data) && j.data.length === 0) {
          // Real workspace, just no revisions for this item — show empty.
          setRevs([]);
          setActiveRev(null);
        }
      } catch {
        // keep seed
      }
    })();
    return () => { cancelled = true; };
  }, [activeId]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader title="Revisions" description="Every write is versioned. Inspect, diff, or revert any prior state." />
      <div style={{ display: "grid", gridTemplateColumns: "280px 220px 1fr", gap: 14, alignItems: "start" }}>
        <div className="card">
          <div className="card-section" style={{ fontSize: 12, fontWeight: 500 }}>Items</div>
          {items.map((it) => (
            <div key={it.id} onClick={() => setActiveId(it.id)} style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", cursor: "pointer", background: activeId === it.id ? "var(--accent)" : "transparent" }}>
              <div style={{ fontSize: 12.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</div>
              <div className="font-mono muted" style={{ fontSize: 10.5 }}>{it.id}</div>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="card-section" style={{ fontSize: 12, fontWeight: 500 }}>Timeline · {item?.title?.slice(0, 18) ?? "—"}…</div>
          {revs.length === 0 && (
            <div className="muted" style={{ padding: "16px 12px", fontSize: 12 }}>No revisions yet for this item.</div>
          )}
          {revs.map((r) => (
            <div key={r.v} onClick={() => setActiveRev(r)} style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", cursor: "pointer", background: activeRev?.v === r.v ? "var(--accent)" : "transparent", display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="font-mono" style={{ fontSize: 12, fontWeight: 500 }}>v{r.v}</span>
                <Badge variant={r.label === "published" ? "default" : "secondary"}>{r.label}</Badge>
              </div>
              <div className="muted font-mono" style={{ fontSize: 10.5 }}>{r.t} · {r.author}</div>
            </div>
          ))}
        </div>
        <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          {!activeRev ? (
            <div style={{ padding: 36, textAlign: "center", color: "var(--muted-foreground)", fontSize: 13 }}>
              Pick a revision from the timeline to inspect, diff, or revert.
            </div>
          ) : (
          <>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Revision v{activeRev.v}</span>
            <Badge variant="secondary">{activeRev.label}</Badge>
            <span className="muted font-mono" style={{ fontSize: 12 }}>{activeRev.t} · {activeRev.author}</span>
            <div className="spacer" />
            <Button size="sm" variant="outline">View full</Button>
            <Button size="sm" variant="primary" icon={I.History}>Revert to this</Button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(activeRev.changes || []).length === 0 && <div className="muted" style={{ fontSize: 12 }}>Initial revision — no diff.</div>}
            {(activeRev.changes || []).map(([field, before, after], i) => (
              <div key={i} className="card" style={{ padding: 12, borderRadius: "var(--radius-xl)", display: "flex", flexDirection: "column", gap: 8 }}>
                <div className="font-mono" style={{ fontSize: 12, fontWeight: 500 }}>{field}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div style={{ padding: 8, background: "color-mix(in oklch, var(--destructive) 8%, var(--card))", border: "1px solid color-mix(in oklch, var(--destructive) 30%, var(--border))", borderRadius: "var(--radius-md)", fontFamily: "Geist Mono, monospace", fontSize: 11.5 }}>
                    <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>before</div>{String(before)}
                  </div>
                  <div style={{ padding: 8, background: "color-mix(in oklch, oklch(0.7 0.18 145) 12%, var(--card))", border: "1px solid color-mix(in oklch, oklch(0.7 0.18 145) 40%, var(--border))", borderRadius: "var(--radius-md)", fontFamily: "Geist Mono, monospace", fontSize: 11.5 }}>
                    <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>after</div>{String(after)}
                  </div>
                </div>
              </div>
            ))}
          </div>
          </>
          )}
        </div>
      </div>
    </div>
  );
}

export function InsightsPage() {
  const [panels, setPanels] = useState<ApiPanel[]>([]);
  const [results, setResults] = useState<Record<string, Record<string, unknown>[]>>({});

  const reload = async () => {
    try {
      const r = await panelsApi.list();
      const list = r.data ?? [];
      setPanels(list);
      // Run each SQL panel in parallel; static/aggregate panels are
      // rendered from their config without a server roundtrip.
      const runs = await Promise.allSettled(
        list.filter((p) => p.kind === "sql").map(async (p) => {
          const out = await panelsApi.run(p.id);
          return [p.id, out.data] as const;
        }),
      );
      const map: Record<string, Record<string, unknown>[]> = {};
      for (const r of runs) if (r.status === "fulfilled") map[r.value[0]] = r.value[1] ?? [];
      setResults(map);
    } catch {
      // leave empty
    }
  };
  useEffect(() => { void reload(); }, []);

  // Show seed examples only when the workspace has zero saved panels — this
  // gives a fresh deploy something to look at while still letting real
  // panels take over once the user creates them.
  const series = useMemo(() => Array.from({ length: 30 }, (_, i) => 800 + Math.round(Math.sin(i / 3) * 200) + Math.round(Math.random() * 240)), []);
  const max = Math.max(...series);
  const traffic = useMemo(() => Array.from({ length: 24 }, () => 300 + Math.round(Math.random() * 1500)), []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader title="Insights" description="Built from saved SQL queries. Drag panels to your own dashboards." actions={<Button variant="primary" icon={I.Plus} onClick={async () => {
        const name = prompt("Panel name", "Untitled panel");
        if (!name) return;
        const sql = prompt("SQL (read-only SELECT)", "SELECT COUNT(*) AS n FROM users;");
        if (!sql) return;
        try {
          await panelsApi.create({
            name,
            description: null,
            kind: "sql",
            sql,
            viz: "counter",
            config: null,
            layout: null,
          });
          await reload();
        } catch {
          // toast handled by api
        }
      }}>New panel</Button>} />
      {panels.length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
          {panels.map((p) => (
            <RealPanel key={p.id} panel={p} rows={results[p.id] ?? []} />
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
        <Panel title="API requests · 30d" sub={`peak ${max.toLocaleString()} / day · sample`}>
          <Sparkline data={series} height={160} fill />
        </Panel>
        <Panel title="Top collections by writes" sub="last 7d · sample">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[["comments", 1280, 0.92], ["posts", 168, 0.18], ["newsletter_subs", 84, 0.10], ["tags", 12, 0.02]].map(([k, n, w]) => (
              <div key={k as string} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span className="font-mono" style={{ fontSize: 12, width: 130 }}>{k as string}</span>
                <div style={{ flex: 1, height: 8, background: "var(--muted)", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${(w as number) * 100}%`, height: "100%", background: "var(--primary)" }} />
                </div>
                <span className="tabular-nums" style={{ fontSize: 12, width: 60, textAlign: "right" }}>{(n as number).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Sign-ups · 24h" sub={`${traffic.reduce((a, b) => a + b, 0).toLocaleString()} requests · sample`}>
          <Sparkline data={traffic} height={160} bars />
        </Panel>
        <Panel title="Auth providers" sub="usage share · sample">
          <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "12px 0" }}>
            <Donut segments={[{ v: 56, color: "var(--primary)" }, { v: 24, color: "oklch(0.7 0.18 260)" }, { v: 12, color: "oklch(0.78 0.16 75)" }, { v: 8, color: "oklch(0.6 0 0)" }]} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
              {[["email", 56, "var(--primary)"], ["github", 24, "oklch(0.7 0.18 260)"], ["google", 12, "oklch(0.78 0.16 75)"], ["passkey", 8, "oklch(0.6 0 0)"]].map(([k, v, c]) => (
                <div key={k as string} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: c as string }} />
                  <span className="font-mono" style={{ flex: 1 }}>{k as string}</span>
                  <span className="tabular-nums">{v as number}%</span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
        </div>
      )}
    </div>
  );
}

/**
 * Renders a saved panel using its viz config and the rows returned by
 * /api/admin/panels/:id/run. We pick the first numeric column for sparkline
 * /bars/counter, pair the first two columns for table/donut, and fall back
 * to JSON for anything we can't auto-detect.
 */
function RealPanel({ panel, rows }: { panel: ApiPanel; rows: Record<string, unknown>[] }) {
  const sub = panel.description ?? `${rows.length} rows · ${panel.kind}`;
  if (rows.length === 0) {
    return (
      <Panel title={panel.name} sub={sub}>
        <div className="muted" style={{ fontSize: 12, padding: "16px 0" }}>No data yet — run the panel.</div>
      </Panel>
    );
  }
  const cols = Object.keys(rows[0] ?? {});
  const numericCol = cols.find((c) => typeof rows[0]![c] === "number");
  const labelCol = cols.find((c) => c !== numericCol);

  if (panel.viz === "counter") {
    const v = numericCol ? Number(rows[0]![numericCol]) : rows.length;
    return (
      <Panel title={panel.name} sub={sub}>
        <div className="tabular-nums" style={{ fontSize: 32, fontWeight: 600, padding: "8px 0" }}>
          {v.toLocaleString()}
        </div>
      </Panel>
    );
  }

  if (panel.viz === "sparkline" || panel.viz === "bars") {
    const data = rows.map((r) => Number(r[numericCol ?? cols[0]!]) || 0);
    return (
      <Panel title={panel.name} sub={sub}>
        <Sparkline data={data} height={160} fill={panel.viz === "sparkline"} bars={panel.viz === "bars"} />
      </Panel>
    );
  }

  if (panel.viz === "donut") {
    const segs = rows.slice(0, 6).map((r, i) => ({
      v: Number(r[numericCol ?? cols[1]!]) || 0,
      color: ["var(--primary)", "oklch(0.7 0.18 260)", "oklch(0.78 0.16 75)", "oklch(0.6 0 0)", "oklch(0.7 0.18 22)", "oklch(0.7 0.18 320)"][i]!,
    }));
    return (
      <Panel title={panel.name} sub={sub}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "12px 0" }}>
          <Donut segments={segs} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
            {rows.slice(0, 6).map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: segs[i]!.color }} />
                <span className="font-mono" style={{ flex: 1 }}>{String(r[labelCol ?? cols[0]!])}</span>
                <span className="tabular-nums">{Number(r[numericCol ?? cols[1]!])}</span>
              </div>
            ))}
          </div>
        </div>
      </Panel>
    );
  }

  // Fallback: small table.
  return (
    <Panel title={panel.name} sub={sub}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        {rows.slice(0, 8).map((r, i) => (
          <div key={i} className="font-mono" style={{ display: "flex", justifyContent: "space-between", borderBottom: i < Math.min(rows.length, 8) - 1 ? "1px solid var(--border)" : "none", paddingBottom: 4 }}>
            <span>{String(r[labelCol ?? cols[0]!])}</span>
            <span className="tabular-nums">{numericCol ? Number(r[numericCol]).toLocaleString() : ""}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Panel({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{title}</span>
        <span className="muted" style={{ fontSize: 11.5 }}>{sub}</span>
      </div>
      {children}
    </div>
  );
}

function Sparkline({ data, height = 60, fill, bars }: { data: number[]; height?: number; fill?: boolean; bars?: boolean }) {
  const max = Math.max(...data, 1);
  const w = 100, h = height;
  if (bars) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
        {data.map((v, i) => (
          <rect key={i} x={i * (w / data.length) + 0.4} y={h - (v / max) * h} width={(w / data.length) - 0.8} height={(v / max) * h} fill="var(--primary)" rx="0.6" />
        ))}
      </svg>
    );
  }
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height }}>
      {fill && <polyline points={`0,${h} ${pts} ${w},${h}`} fill="color-mix(in oklch, var(--primary) 18%, transparent)" stroke="none" />}
      <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Donut({ segments }: { segments: { v: number; color: string }[] }) {
  const total = segments.reduce((a, s) => a + s.v, 0);
  let acc = 0;
  const r = 36, cx = 50, cy = 50;
  return (
    <svg width="120" height="120" viewBox="0 0 100 100">
      {segments.map((s, i) => {
        const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2;
        acc += s.v;
        const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
        const x0 = cx + Math.cos(a0) * r, y0 = cy + Math.sin(a0) * r;
        const x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
        const large = s.v / total > 0.5 ? 1 : 0;
        return <path key={i} d={`M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`} fill={s.color} />;
      })}
      <circle cx={cx} cy={cy} r="22" fill="var(--card)" />
    </svg>
  );
}

export function EmailTemplatesPage({ pushToast }: { pushToast: (m: string) => void }) {
  type Tpl = { id: string; key?: string; name: string; subject: string; vars: string[]; bodyHtml?: string };
  const SEED: Tpl[] = [
    { id: "verify", key: "verify", name: "Email verification", subject: "Confirm your email", vars: ["user.email", "confirm_url"] },
    { id: "reset", key: "reset", name: "Password reset", subject: "Reset your password", vars: ["user.email", "reset_url"] },
    { id: "magic", key: "magic", name: "Magic link", subject: "Your sign-in link", vars: ["user.email", "magic_url"] },
    { id: "invite", key: "invite", name: "Invite", subject: "You've been invited to {{site.name}}", vars: ["inviter.email", "accept_url"] },
    { id: "change_email", key: "change_email", name: "Change email", subject: "Confirm your new email", vars: ["user.email", "confirm_url"] },
  ];
  const [templates, setTemplates] = useState<Tpl[]>(SEED);
  const [active, setActive] = useState<Tpl>(SEED[0]!);
  const [body, setBody] = useState(`<h1>Hi {{ user.email }},</h1>\n<p>Click the button below to confirm your email address. The link expires in 1 hour.</p>\n<a href="{{ confirm_url }}" class="btn">Confirm email</a>\n<p>If you didn't request this, you can safely ignore this email.</p>`);
  const [subject, setSubject] = useState(active.subject);
  const [fromAddress, setFromAddress] = useState("hello@workeros.dev");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await emailTemplatesApi.list();
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          const mapped: Tpl[] = res.data.map((t: ApiEmailTemplate) => ({
            id: t.id,
            key: t.key,
            name: t.name,
            subject: t.subject,
            vars: t.variables ?? [],
            bodyHtml: t.bodyHtml,
          }));
          setTemplates(mapped);
          if (mapped[0]) {
            setActive(mapped[0]);
            setSubject(mapped[0].subject);
            setBody(mapped[0].bodyHtml ?? body);
            if (res.data[0]?.fromAddress) setFromAddress(res.data[0].fromAddress);
          }
        }
      } catch {
        // keep seed
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSelect = async (t: Tpl) => {
    setActive(t);
    setSubject(t.subject);
    if (t.bodyHtml) {
      setBody(t.bodyHtml);
      return;
    }
    try {
      const res = await emailTemplatesApi.get(t.id);
      setBody(res.data.bodyHtml);
      if (res.data.fromAddress) setFromAddress(res.data.fromAddress);
    } catch {
      // keep current body
    }
  };

  const onSave = async () => {
    try {
      if (active.key) {
        await emailTemplatesApi.patch(active.id, {
          subject,
          bodyHtml: body,
          fromAddress,
        });
      } else {
        await emailTemplatesApi.create({
          key: active.id,
          name: active.name,
          subject,
          fromAddress,
          bodyHtml: body,
          bodyText: null,
          variables: active.vars,
        });
      }
      pushToast("Template saved.");
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const onSendTest = async () => {
    try {
      await emailTemplatesApi.sendTest(active.id);
      pushToast("Test email sent.");
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  const preview = body
    .replace(/{{\s*user\.email\s*}}/g, "rana@workeros.dev")
    .replace(/{{\s*confirm_url\s*}}/g, "https://workeros.dev/auth/verify?token=…")
    .replace(/{{\s*reset_url\s*}}/g, "https://workeros.dev/auth/reset?token=…")
    .replace(/{{\s*magic_url\s*}}/g, "https://workeros.dev/auth/magic?token=…")
    .replace(/{{\s*site\.name\s*}}/g, "workeros");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader title="Email templates" description={<>Variables use Liquid-style <span className="font-mono">{"{{ user.email }}"}</span>. Template renders run through the Functions sandbox.</>} />
      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr 1fr", gap: 14, alignItems: "start" }}>
        <div className="card">
          {templates.map((t) => (
            <div key={t.id} onClick={() => void onSelect(t)} style={{ padding: "10px 12px", borderTop: "1px solid var(--border)", cursor: "pointer", background: active.id === t.id ? "var(--accent)" : "transparent" }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t.name}</div>
              <div className="font-mono muted" style={{ fontSize: 11 }}>{t.key ?? t.id}</div>
            </div>
          ))}
        </div>
        <div className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 500 }}>Editor</span>
            <div className="spacer" />
            <Button size="sm" variant="outline" icon={I.Mail} onClick={onSendTest}>Send test</Button>
            <Button size="sm" variant="primary" icon={I.Save} onClick={onSave}>Save</Button>
          </div>
          <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="field"><label className="field-label">Subject</label><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
            <div className="field"><label className="field-label">From</label><input className="input" value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} /></div>
            <div className="field">
              <label className="field-label">Body (HTML)</label>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} style={{ width: "100%", minHeight: 220, padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", background: "oklch(0.18 0.01 130)", color: "oklch(0.92 0.02 130)", fontFamily: "Geist Mono, monospace", fontSize: 12.5, lineHeight: 1.55, resize: "vertical" }} />
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {active.vars.map((v) => (
                <button key={v} onClick={() => setBody((b) => b + `{{ ${v} }}`)} className="chip"><I.Code size={11} /> {`{{ ${v} }}`}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="card-section"><span style={{ fontSize: 12, fontWeight: 500 }}>Preview</span></div>
          <div style={{ padding: 24, background: "oklch(0.97 0.005 130)", minHeight: 280 }}>
            <div style={{ background: "white", borderRadius: 12, padding: 28, maxWidth: 480, margin: "0 auto", boxShadow: "0 1px 4px oklch(0 0 0 / 0.06)", color: "#1a1a1a" }} dangerouslySetInnerHTML={{ __html: preview.replace(/<a /g, '<a style="display:inline-block;margin-top:8px;padding:10px 16px;background:oklch(0.85 0.18 125);color:#1a1a1a;border-radius:999px;text-decoration:none;font-weight:500;font-family:Geist,sans-serif" ') }} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function TranslationsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const locales = ["en", "tr", "de", "es", "fr", "ja"] as const;
  const initialKeys = [
    { key: "app.title", en: "workeros", tr: "workeros", de: "workeros", es: "workeros", fr: "workeros", ja: "workeros" },
    { key: "auth.sign_in", en: "Sign in", tr: "Giriş yap", de: "Anmelden", es: "Iniciar sesión", fr: "Se connecter", ja: "サインイン" },
    { key: "auth.sign_up", en: "Sign up", tr: "Kayıt ol", de: "Registrieren", es: "Registrarse", fr: "S'inscrire", ja: "サインアップ" },
    { key: "collections.posts.title", en: "Posts", tr: "Yazılar", de: "Beiträge", es: "Publicaciones", fr: "Articles", ja: "投稿" },
    { key: "collections.posts.new", en: "New post", tr: "Yeni yazı", de: "Neuer Beitrag", es: "Nueva publicación", fr: "Nouvel article", ja: "" },
    { key: "storage.upload", en: "Upload", tr: "Yükle", de: "Hochladen", es: "Subir", fr: "Téléverser", ja: "アップロード" },
    { key: "common.save", en: "Save", tr: "Kaydet", de: "Speichern", es: "", fr: "Enregistrer", ja: "保存" },
    { key: "common.delete", en: "Delete", tr: "Sil", de: "Löschen", es: "Eliminar", fr: "Supprimer", ja: "削除" },
  ] as Record<string, string>[];
  const [data, setData] = useState(initialKeys);
  const [base, setBase] = useState("en");
  const [showOnly, setShowOnly] = useState("all");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await i18nApi.matrix();
        if (cancelled) return;
        const keys = Object.keys(res.data || {});
        if (keys.length > 0) {
          const rows = keys.map((k) => {
            const row: Record<string, string> = { key: k };
            for (const l of locales) row[l] = res.data[k]?.[l] ?? "";
            return row;
          });
          setData(rows);
        }
      } catch {
        // keep seed
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const persist = (key: string, locale: string, value: string) => {
    void i18nApi.upsert(key, locale, value).catch((e: Error) => pushToast?.(e.message));
  };
  const visible = showOnly === "missing" ? data.filter((r) => locales.some((l) => !r[l])) : data;
  const completion = locales.map((l) => ({ l, pct: Math.round(data.filter((r) => r[l]).length / data.length * 100) }));
  const update = (key: string, locale: string, value: string) => {
    setData((arr) => arr.map((r) => r.key === key ? { ...r, [locale]: value } : r));
    persist(key, locale, value);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Translations"
        description={<>Multi-locale content. Field-level translations attach to <span className="font-mono">c_*_translations</span> sibling tables; UI strings live here.</>}
        actions={<>
          <Button variant="outline" icon={I.Download} onClick={() => {
            const out: Record<string, Record<string, string>> = {};
            for (const r of data) {
              out[r.key] = {};
              for (const l of locales) out[r.key]![l] = r[l] || "";
            }
            const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = "translations.json"; a.click();
            URL.revokeObjectURL(url);
            pushToast("Exported translations.json.");
          }}>Export</Button>
          <Button variant="primary" icon={I.Plus} onClick={async () => {
            const key = prompt("New i18n key (e.g. common.cancel)", "common.cancel");
            if (!key) return;
            const seed: Record<string, string> = { key };
            for (const l of locales) seed[l] = "";
            setData((arr) => [...arr, seed]);
            try {
              await i18nApi.upsert(key, base, "");
              pushToast(`Key "${key}" added.`);
            } catch (e) {
              pushToast((e as Error).message);
            }
          }}>New key</Button>
        </>}
      />
      <div className="card" style={{ padding: 14, display: "grid", gridTemplateColumns: `repeat(${locales.length}, 1fr)`, gap: 12 }}>
        {completion.map((c) => (
          <div key={c.l}>
            <div className="muted" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{c.l}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="tabular-nums" style={{ fontWeight: 500 }}>{c.pct}%</span>
              <div style={{ flex: 1, height: 4, background: "var(--muted)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ width: `${c.pct}%`, height: "100%", background: c.pct === 100 ? "oklch(0.7 0.18 145)" : c.pct < 80 ? "oklch(0.78 0.16 75)" : "var(--primary)" }} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="filter-bar">
        <span className="muted" style={{ fontSize: 11.5 }}>base</span>
        <Select value={base} onChange={setBase} options={[...locales]} />
        <button className={`chip ${showOnly === "all" ? "active" : ""}`} onClick={() => setShowOnly("all")}>All ({data.length})</button>
        <button className={`chip ${showOnly === "missing" ? "active" : ""}`} onClick={() => setShowOnly("missing")}>Missing ({data.filter((r) => locales.some((l) => !r[l])).length})</button>
      </div>
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table className="table" style={{ minWidth: 100 + locales.length * 160 }}>
          <thead>
            <tr>
              <th style={{ width: 220, position: "sticky", left: 0, background: "var(--card)", zIndex: 1 }}>Key</th>
              {locales.map((l) => <th key={l} style={{ minWidth: 160 }}>{l}{l === base && <span className="muted"> · base</span>}</th>)}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.key}>
                <td className="font-mono" style={{ fontSize: 12, position: "sticky", left: 0, background: "var(--card)" }}>{r.key}</td>
                {locales.map((l) => (
                  <td key={l} style={{ padding: 0 }}>
                    <input value={r[l] || ""} onChange={(e) => update(r.key, l, e.target.value)} placeholder={l === base ? "" : (r[base] || "—")} style={{ width: "100%", border: 0, outline: 0, background: !r[l] ? "color-mix(in oklch, oklch(0.78 0.16 75) 8%, transparent)" : "transparent", padding: "10px 12px", fontSize: 12.5, fontFamily: l === "ja" ? "inherit" : "Geist, sans-serif", color: !r[l] ? "var(--muted-foreground)" : "var(--foreground)" }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
