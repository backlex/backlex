// @ts-nocheck
// directus/supabase parity pages — Database, Auth, Activity, Revisions, Insights, Email, Translations
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useIsMobile } from "@workeros/ui/hooks/use-mobile";
import { I } from "./icons";
import { ADAPTER_PROFILES, type AdapterId } from "./config";
import { Badge, Button, IconButton, PageHeader, Switch } from "./ui";
import { Select } from "./select";
import { ConfirmDialog } from "./sheet";
import { ApiError } from "@/lib/api";
import {
  activityApi,
  authAdminApi,
  collectionsApi,
  dbAdminApi,
  emailTemplatesApi,
  i18nApi,
  panelsApi,
  type ApiActivity,
  type ApiAuthConfig,
  type ApiCollection,
  type ApiEmailTemplate,
  type ApiPanel,
  type ApiSession,
} from "./api";

const I18N_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

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
    </div>
  );
}

type AuthProviderRow = {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  system?: boolean;
  clientId?: string | null;
  discoveryUrl?: string | null;
};

const AUTH_PROVIDER_NAMES: Record<string, string> = {
  email: "Email + password",
  magic: "Magic link",
  github: "GitHub",
  google: "Google",
  apple: "Apple",
  microsoft: "Microsoft",
  discord: "Discord",
  passkey: "Passkeys (WebAuthn)",
};
const AUTH_OAUTH_IDS = new Set(["github", "google", "apple", "microsoft", "discord"]);
const SESSION_LIFETIMES = ["1h", "24h", "7d", "30d", "90d"];
const POLICY_ROWS: { key: string; label: string; desc: string; fallback: boolean }[] = [
  { key: "requireEmailVerification", label: "Require email verification", desc: "Users must confirm their email before sign-in.", fallback: true },
  { key: "mfaTotp", label: "Multi-factor (TOTP)", desc: "Users can enroll an authenticator app.", fallback: true },
  { key: "mfaRequiredForAdmins", label: "Multi-factor required for admins", desc: "Force admins to enroll MFA.", fallback: false },
  { key: "passkeys", label: "Passkeys", desc: "WebAuthn-based passwordless sign-in.", fallback: true },
  { key: "openSignup", label: "Open sign-up", desc: "Anyone can create an account.", fallback: true },
];

const isHttpUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const providerKind = (p: AuthProviderRow): "oauth" | "builtin" | "custom" =>
  p.system ? (AUTH_OAUTH_IDS.has(p.id) ? "oauth" : "builtin") : "custom";

const mapAuthProviders = (map: Record<string, any> | undefined): AuthProviderRow[] => {
  const rows: AuthProviderRow[] = Object.entries(map ?? {}).map(([id, v]) => ({
    id,
    name: (v && v.name) || AUTH_PROVIDER_NAMES[id] || id,
    enabled: !!(v && v.enabled),
    configured: !!(v && v.configured),
    system: !!(v && v.system),
    clientId: (v && v.clientId) ?? null,
    discoveryUrl: (v && v.discoveryUrl) ?? null,
  }));
  // Stable order: built-ins first, then alphabetical.
  rows.sort((a, b) => (a.system !== b.system ? (a.system ? -1 : 1) : a.id.localeCompare(b.id)));
  return rows;
};

export function AuthSettingsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const [providers, setProviders] = useState<AuthProviderRow[]>([]);
  const [policy, setPolicy] = useState<Record<string, boolean>>({});
  const [sessionLifetime, setSessionLifetime] = useState("30d");
  const [redirectText, setRedirectText] = useState("");
  const redirectSavedRef = useRef("");
  const [sessions, setSessions] = useState<{ id: string; user: string; device: string; ip: string; loc: string; created: string; last: string; current: boolean }[]>([]);
  const [configuring, setConfiguring] = useState<AuthProviderRow | null>(null);
  const [adding, setAdding] = useState(false);

  const loadConfig = async () => {
    const cfg = await authAdminApi.config();
    const data = (cfg.data ?? {}) as ApiAuthConfig;
    setProviders(mapAuthProviders(data.providers as Record<string, any>));
    setPolicy((data.policy ?? {}) as Record<string, boolean>);
    setSessionLifetime(data.sessionLifetime || "30d");
    const text = (data.redirectUrls ?? []).join("\n");
    setRedirectText(text);
    redirectSavedRef.current = text;
  };

  const mapSession = (s: ApiSession) => ({
    id: s.id,
    user: s.userEmail,
    device: (s.userAgent ?? "unknown agent").slice(0, 48),
    ip: s.ipAddress ?? "—",
    loc: "—",
    created: new Date(s.createdAt).toISOString().replace("T", " ").slice(0, 19),
    last: fmtRelative(s.updatedAt ?? s.createdAt),
    current: !!s.current,
  });
  const loadSessions = async () => {
    const ss = await authAdminApi.sessions();
    setSessions((ss.data ?? []).map(mapSession));
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadConfig();
      } catch {
        // keep defaults — the providers list reflects what the worker actually has
      }
      if (cancelled) return;
      try {
        await loadSessions();
      } catch (e) {
        pushToast?.((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushToast]);

  const toggleProvider = async (id: string, enabled: boolean) => {
    setProviders((arr) => arr.map((p) => (p.id === id ? { ...p, enabled } : p)));
    try {
      await authAdminApi.patch({ providers: { [id]: { enabled } } });
    } catch (e) {
      pushToast?.((e as Error).message);
      setProviders((arr) => arr.map((p) => (p.id === id ? { ...p, enabled: !enabled } : p)));
    }
  };

  const saveProviderConfig = async (id: string, patch: Record<string, unknown>) => {
    try {
      await authAdminApi.patch({ providers: { [id]: patch } });
      await loadConfig();
      pushToast?.(`${AUTH_PROVIDER_NAMES[id] ?? id} settings saved.`);
      setConfiguring(null);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const addProvider = async (id: string, patch: Record<string, unknown>) => {
    if (providers.some((p) => p.id === id)) {
      pushToast?.(`A provider with id "${id}" already exists.`);
      return;
    }
    try {
      await authAdminApi.patch({ providers: { [id]: { enabled: false, configured: false, system: false, ...patch } } });
      await loadConfig();
      pushToast?.(`Added provider "${id}".`);
      setAdding(false);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const setPolicyFlag = async (key: string, on: boolean) => {
    setPolicy((p) => ({ ...p, [key]: on }));
    try {
      await authAdminApi.patch({ policy: { [key]: on } });
    } catch (e) {
      pushToast?.((e as Error).message);
      setPolicy((p) => ({ ...p, [key]: !on }));
    }
  };

  const saveSessionLifetime = async (v: string) => {
    const prev = sessionLifetime;
    setSessionLifetime(v);
    try {
      await authAdminApi.patch({ sessionLifetime: v });
      pushToast?.(`Session lifetime set to ${v}.`);
    } catch (e) {
      pushToast?.((e as Error).message);
      setSessionLifetime(prev);
    }
  };

  const saveRedirects = async () => {
    const urls = redirectText.split("\n").map((s) => s.trim()).filter(Boolean);
    const joined = urls.join("\n");
    if (joined === redirectSavedRef.current) return;
    const bad = urls.find((u) => !isHttpUrl(u));
    if (bad) {
      pushToast?.(`"${bad}" isn't a valid URL — use e.g. https://app.example.com/auth/callback.`);
      return;
    }
    try {
      await authAdminApi.patch({ redirectUrls: urls });
      redirectSavedRef.current = joined;
      pushToast?.(`Saved ${urls.length} redirect URL${urls.length === 1 ? "" : "s"}.`);
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
      pushToast?.(`Revoked ${r.removed} other session${r.removed === 1 ? "" : "s"}.`);
      await loadSessions();
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };

  const userCount = new Set(sessions.map((s) => s.user)).size;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader title="Authentication" description={<>Configure sign-in methods, MFA, and session policy. Tokens are signed with <span className="font-mono">$AUTH_SECRET</span>.</>} />
      <div className="split">
        <div className="card">
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Providers</span>
            <div className="spacer" />
            <Button size="sm" variant="outline" icon={I.Plus} onClick={() => setAdding(true)}>Add</Button>
          </div>
          {providers.length === 0 && <div className="card-section muted" style={{ fontSize: 12.5 }}>Couldn't load auth config.</div>}
          {providers.map((p) => {
            const lockedOff = !p.configured && !p.enabled;
            return (
            <div key={p.id} className="schema-row" style={{ gridTemplateColumns: "24px 1fr auto auto auto" }}>
              <span><I.Shield size={13} /></span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</div>
                {p.clientId && <div className="font-mono muted" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{p.clientId}</div>}
                {!p.clientId && p.discoveryUrl && <div className="font-mono muted" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>{p.discoveryUrl}</div>}
                {p.system && <div className="muted" style={{ fontSize: 11 }}>built-in</div>}
                {p.enabled && !p.configured && <div style={{ fontSize: 11, color: "var(--destructive)" }}>enabled but not configured — won't appear on sign-in</div>}
              </div>
              {!p.configured && <Badge variant={p.enabled ? "destructive" : "secondary"}>not configured</Badge>}
              <Button size="sm" variant="ghost" onClick={() => setConfiguring(p)}>Configure</Button>
              <Switch
                checked={p.enabled}
                disabled={lockedOff}
                title={lockedOff ? "Configure this provider (add a Client ID) before enabling it" : undefined}
                onChange={(v) => toggleProvider(p.id, v)}
              />
            </div>
            );
          })}
        </div>
        <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>Policy</span>
          {POLICY_ROWS.map((r) => (
            <div key={r.key} className="field-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
              <div>
                <div className="field-label">{r.label}</div>
                <div className="field-hint">{r.desc}</div>
              </div>
              <Switch checked={policy[r.key] ?? r.fallback} onChange={(v) => setPolicyFlag(r.key, v)} />
            </div>
          ))}
          <div className="field" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
            <label className="field-label">Session lifetime</label>
            <Select value={sessionLifetime} onChange={(v) => void saveSessionLifetime(v)} options={SESSION_LIFETIMES} />
          </div>
          <div className="field">
            <label className="field-label">Allowed redirect URLs</label>
            <textarea
              className="input"
              rows={3}
              value={redirectText}
              onChange={(e) => setRedirectText(e.target.value)}
              onBlur={() => void saveRedirects()}
              placeholder={"https://app.example.com/auth/callback\nhttp://localhost:5173/auth/callback"}
              style={{ height: "auto", fontFamily: "Geist Mono, monospace", fontSize: 12 }}
            />
            <span className="field-hint">One URL per line — saved when you click away.</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.Activity size={13} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>Active sessions</span>
          <span className="muted font-mono" style={{ fontSize: 11.5 }}>{sessions.length} session{sessions.length === 1 ? "" : "s"} · {userCount} user{userCount === 1 ? "" : "s"}</span>
          <div className="spacer" />
          <Button size="sm" variant="outline" icon={I.LogOut} onClick={revokeOthers}>Revoke others</Button>
        </div>
        <div className="table-scroll">
        <table className="table">
          <thead><tr><th>User</th><th>Device</th><th>Location</th><th>IP</th><th>Created</th><th>Last seen</th><th></th></tr></thead>
          <tbody>
            {sessions.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 14 }}>No active sessions.</td></tr>}
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

      {configuring && (
        <ProviderConfigDialog
          provider={configuring}
          kind={providerKind(configuring)}
          onClose={() => setConfiguring(null)}
          onSave={(patch) => void saveProviderConfig(configuring.id, patch)}
        />
      )}
      {adding && (
        <AddProviderDialog
          existingIds={providers.map((p) => p.id)}
          onClose={() => setAdding(false)}
          onAdd={(id, patch) => void addProvider(id, patch)}
        />
      )}
    </div>
  );
}

function ProviderConfigDialog({ provider, kind, onClose, onSave }: {
  provider: AuthProviderRow;
  kind: "oauth" | "builtin" | "custom";
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [enabled, setEnabled] = useState(provider.enabled);
  const [name, setName] = useState(provider.name ?? "");
  const [clientId, setClientId] = useState(provider.clientId ?? "");
  const [discoveryUrl, setDiscoveryUrl] = useState(provider.discoveryUrl ?? "");

  const usesClientId = kind === "oauth" || kind === "custom";
  const needsClientId = usesClientId && !clientId.trim();
  const discoveryBad = !!discoveryUrl.trim() && !isHttpUrl(discoveryUrl.trim());
  const valid = kind === "custom" ? name.trim().length >= 2 && !discoveryBad : !discoveryBad;

  const submit = () => {
    if (!valid) return;
    const hasClientId = !!clientId.trim();
    const patch: Record<string, unknown> = {};
    if (kind === "oauth") {
      patch.clientId = clientId.trim() || null;
      patch.configured = hasClientId;
      patch.enabled = hasClientId ? enabled : false;
    } else if (kind === "custom") {
      patch.name = name.trim();
      patch.clientId = clientId.trim() || null;
      patch.discoveryUrl = discoveryUrl.trim() || null;
      patch.configured = hasClientId;
      patch.enabled = hasClientId ? enabled : false;
    } else {
      patch.enabled = enabled;
    }
    onSave(patch);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, width: "92vw" }}>
        <div className="dialog-head">
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>Configure {provider.name}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
              {kind === "oauth" ? "OAuth 2.0 / OIDC sign-in provider." : kind === "custom" ? "Custom OpenID Connect provider." : "Built-in sign-in method."}
            </div>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>
        <div className="dialog-body">
          <div className="field-row">
            <div>
              <div className="field-label">Enabled</div>
              <div className="field-hint">{needsClientId ? "Add a Client ID below first." : "Show this option on the sign-in screen."}</div>
            </div>
            <Switch checked={enabled && !needsClientId} disabled={needsClientId} title={needsClientId ? "Add a Client ID first" : undefined} onChange={setEnabled} />
          </div>
          {kind === "custom" && (
            <div className="field">
              <label className="field-label">Display name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme SSO" />
            </div>
          )}
          {(kind === "oauth" || kind === "custom") && (
            <div className="field">
              <label className="field-label">Client ID</label>
              <input className="input font-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="123456789-abc.apps.example.com" />
            </div>
          )}
          {kind === "custom" && (
            <div className="field">
              <label className="field-label">Discovery URL <span className="muted">(optional)</span></label>
              <input className="input font-mono" value={discoveryUrl} onChange={(e) => setDiscoveryUrl(e.target.value)} placeholder="https://issuer.example.com/.well-known/openid-configuration" />
              {discoveryBad && <span className="field-hint" style={{ color: "var(--destructive)" }}>Must be a full http(s) URL.</span>}
            </div>
          )}
          {(kind === "oauth" || kind === "custom") && (
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              The client secret is read from the <span className="font-mono">OAUTH_{provider.id.toUpperCase()}_CLIENT_SECRET</span> environment variable — it is never stored or shown here.
            </div>
          )}
          {kind === "builtin" && (
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              {provider.id === "email"
                ? "Email + password is always available — toggle it off to hide the form from the sign-in screen."
                : provider.id === "passkey"
                  ? "Users enrol a passkey after signing in once with another method."
                  : "Sends a one-time sign-in link by email — requires a configured email adapter (set RESEND_API_KEY + EMAIL_FROM)."}
            </div>
          )}
        </div>
        <div className="dialog-foot">
          <div className="spacer" />
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon={I.Check} disabled={!valid} onClick={submit}>Save</Button>
        </div>
      </div>
    </div>
  );
}

function AddProviderDialog({ existingIds, onClose, onAdd }: {
  existingIds: string[];
  onClose: () => void;
  onAdd: (id: string, patch: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState("");
  const [discoveryUrl, setDiscoveryUrl] = useState("");
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const idTaken = !!slug && existingIds.includes(slug);
  const discoveryBad = !!discoveryUrl.trim() && !isHttpUrl(discoveryUrl.trim());
  const valid = slug.length >= 2 && !idTaken && !discoveryBad;

  const submit = () => {
    if (!valid) return;
    onAdd(slug, {
      name: name.trim(),
      clientId: clientId.trim() || null,
      discoveryUrl: discoveryUrl.trim() || null,
      configured: !!clientId.trim(),
    });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, width: "92vw" }}>
        <div className="dialog-head">
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>Add OIDC provider</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>Register a custom OpenID Connect identity provider.</div>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>
        <div className="dialog-body">
          <div className="field">
            <label className="field-label">Display name</label>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme SSO" />
            <span className="field-hint font-mono" style={{ fontSize: 11 }}>
              id: <span style={{ color: idTaken ? "var(--destructive)" : "var(--foreground)" }}>{slug || "—"}</span>
              {idTaken && <span style={{ color: "var(--destructive)" }}> · already exists</span>}
            </span>
          </div>
          <div className="field">
            <label className="field-label">Client ID <span className="muted">(optional)</span></label>
            <input className="input font-mono" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="abc123" />
          </div>
          <div className="field">
            <label className="field-label">Discovery URL <span className="muted">(optional)</span></label>
            <input className="input font-mono" value={discoveryUrl} onChange={(e) => setDiscoveryUrl(e.target.value)} placeholder="https://issuer.example.com/.well-known/openid-configuration" />
            {discoveryBad && <span className="field-hint" style={{ color: "var(--destructive)" }}>Must be a full http(s) URL.</span>}
          </div>
          <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
            The provider is added disabled. Set its client secret server-side, then enable it here.
          </div>
        </div>
        <div className="dialog-foot">
          <span className="muted" style={{ fontSize: 12 }}>{valid ? "Will be added disabled." : idTaken ? "Pick a unique name." : "Enter a name to continue."}</span>
          <div className="spacer" />
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon={I.Plus} disabled={!valid} onClick={submit}>Add provider</Button>
        </div>
      </div>
    </div>
  );
}

export function ActivityPage({ pushToast }: { pushToast: (m: string) => void }) {
  type Evt = { t: string; actor: string; action: string; resource: string; diff: string; ip: string };
  const PAGE_SIZE = 50;
  const [events, setEvents] = useState<Evt[]>([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  // hasMore stays true until a fetch returns fewer rows than requested.
  const [hasMore, setHasMore] = useState(true);

  const mapRow = (a: ApiActivity): Evt => ({
    t: new Date(a.createdAt).toISOString().replace("T", " ").slice(0, 19),
    actor: a.userId ?? "system",
    action: a.action,
    resource: `${a.collection}${a.itemId ? "/" + a.itemId : ""}`,
    diff: typeof a.payload === "string" ? a.payload : JSON.stringify(a.payload ?? {}).slice(0, 80),
    ip: a.ip ?? "—",
  });

  const fetchPage = async (offset: number, append: boolean) => {
    setLoading(true);
    try {
      const res = await activityApi.list({ limit: PAGE_SIZE, offset });
      if (Array.isArray(res.data)) {
        const mapped = res.data.map(mapRow);
        setEvents((prev) => (append ? [...prev, ...mapped] : mapped));
        setHasMore(res.data.length === PAGE_SIZE);
      }
    } catch (e) {
      pushToast?.((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchPage(0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        {["all", "item", "auth", "schema", "role", "storage", "flow", "function", "webhook", "backup"].map((k) => (
          <button key={k} className={`chip ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>{k} <span className="muted tabular-nums">{k === "all" ? events.length : events.filter((e) => e.action.startsWith(k)).length}</span></button>
        ))}
      </div>
      <div className="card">
        <div className="table-scroll">
        <table className="table">
          <thead><tr><th style={{ width: 160, whiteSpace: "nowrap" }}>Time</th><th style={{ width: 200 }}>Actor</th><th style={{ width: 140 }}>Action</th><th>Resource</th><th>Diff</th><th style={{ width: 130 }}>IP</th></tr></thead>
          <tbody>
            {visible.map((e, i) => (
              <tr key={i}>
                <td className="font-mono muted tabular-nums" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{e.t}</td>
                <td style={{ wordBreak: "break-all" }}>{e.actor}</td>
                <td><Badge variant={actionColor(e.action)} mono>{e.action}</Badge></td>
                <td className="font-mono" style={{ fontSize: 12 }}>{e.resource}</td>
                <td className="font-mono muted" style={{ fontSize: 11.5 }}>{e.diff}</td>
                <td className="font-mono muted" style={{ fontSize: 11.5 }}>{e.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderTop: "1px solid var(--border)" }}>
          <span className="muted tabular-nums" style={{ fontSize: 12 }}>
            {filter === "all"
              ? `${events.length} loaded${hasMore ? "" : " · end"}`
              : `${visible.length} of ${events.length} loaded${hasMore ? "" : " · end"}`}
          </span>
          <Button
            variant="outline"
            disabled={!hasMore || loading}
            onClick={() => void fetchPage(events.length, true)}
          >
            {loading ? "Loading…" : hasMore ? "Load more" : "No more rows"}
          </Button>
        </div>
      </div>
    </div>
  );
}

const REV_AUTO_FIELDS = new Set([
  "id",
  "created_at",
  "createdAt",
  "updated_at",
  "updatedAt",
  "owner_id",
  "ownerId",
]);

const stableStringify = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? "undefined";
  } catch {
    return String(v);
  }
};

const fmtRevValue = (v: unknown): string => {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v === "" ? '""' : v;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  return String(v);
};

const fmtRevTs = (v: string | number): string => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16).replace("T", " ");
};

export function RevisionsPage({ pushToast }: { pushToast?: (m: string, t?: "success" | "error") => void } = {}) {
  const toast = pushToast ?? (() => {});

  // Revisions are scoped to a (collection, itemId) pair, so we need both to
  // query the API. Pick the first existing collection on mount, then its items.
  type RowItem = { id: string; title: string };
  const [items, setItems] = useState<RowItem[]>([]);
  const [collectionSlug, setCollectionSlug] = useState<string>("posts");
  const [activeId, setActiveId] = useState<string>("");
  const [itemsLoading, setItemsLoading] = useState(true);
  const item = items.find((x) => x.id === activeId);

  const loadItems = async (slug: string) => {
    setItemsLoading(true);
    try {
      const ir = await fetch(`/api/items/${encodeURIComponent(slug)}?limit=20&sort=-updated_at`, { credentials: "include" });
      if (!ir.ok) { setItems([]); return; }
      const ij = (await ir.json()) as { data?: any[] };
      const rows = (ij.data ?? []).map((r) => ({
        id: r.id,
        title: String(r.title ?? r.name ?? r.slug ?? r.id ?? "").slice(0, 48) || r.id,
      }));
      setItems(rows);
      setActiveId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? ""));
    } catch {
      setItems([]);
    } finally {
      setItemsLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cr = await fetch("/api/collections", { credentials: "include" });
        if (!cr.ok || cancelled) { setItemsLoading(false); return; }
        const cj = (await cr.json()) as { data?: { slug: string }[] };
        const slug = cj.data?.[0]?.slug ?? "posts";
        if (cancelled) return;
        setCollectionSlug(slug);
        await loadItems(slug);
      } catch {
        if (!cancelled) setItemsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  type RawRev = { id: string; createdAt: string | number; createdBy: string | null; snapshot: Record<string, unknown> };
  // Each recorded revision is a *pre-image*: the row state captured right
  // before a write. The live row is the only "current" state — so the
  // timeline is [live] + [revisions, newest-first].
  type Entry =
    | { kind: "live"; snapshot: Record<string, unknown> }
    | { kind: "rev"; id: string; v: number; createdAt: string | number; createdBy: string | null; snapshot: Record<string, unknown> };
  const [revs, setRevs] = useState<RawRev[]>([]);
  const [live, setLive] = useState<Record<string, unknown> | null>(null);
  const [revsLoading, setRevsLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [showFull, setShowFull] = useState(false);
  const [confirmRev, setConfirmRev] = useState<{ id: string; v: number; createdAt: string | number } | null>(null);
  const [reverting, setReverting] = useState(false);

  const loadTimeline = async (slug: string, id: string) => {
    if (!id) { setRevs([]); setLive(null); setActiveIdx(0); return; }
    setRevsLoading(true);
    try {
      const [rr, ir] = await Promise.all([
        fetch(`/api/revisions/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`, { credentials: "include" }),
        fetch(`/api/items/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`, { credentials: "include" }),
      ]);
      const rj = rr.ok ? ((await rr.json()) as { data?: RawRev[] }) : { data: [] };
      const ij = ir.ok ? ((await ir.json()) as { data?: Record<string, unknown> }) : { data: null };
      setRevs(Array.isArray(rj.data) ? rj.data : []);
      setLive(ij.data ?? null);
      setActiveIdx(0);
    } catch {
      setRevs([]);
      setLive(null);
    } finally {
      setRevsLoading(false);
    }
  };

  useEffect(() => {
    void loadTimeline(collectionSlug, activeId);
    setShowFull(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionSlug, activeId]);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    if (live) out.push({ kind: "live", snapshot: live });
    const n = revs.length;
    revs.forEach((r, i) => {
      out.push({ kind: "rev", id: r.id, v: n - i, createdAt: r.createdAt, createdBy: r.createdBy, snapshot: r.snapshot ?? {} });
    });
    return out;
  }, [live, revs]);

  const active = entries[activeIdx] ?? null;
  // The "before" side of the diff is the next-older state in the timeline.
  const prev = active ? entries[activeIdx + 1] ?? null : null;
  const hasPrev = !!prev;

  const diff = useMemo(() => {
    if (!active) return [] as { field: string; before: unknown; after: unknown; changed: boolean }[];
    const cur = active.snapshot ?? {};
    const before = prev?.snapshot ?? null;
    const keys = Array.from(new Set([...Object.keys(cur), ...(before ? Object.keys(before) : [])]));
    return keys.map((k) => {
      const a = before ? before[k] : undefined;
      const b = cur[k];
      return { field: k, before: a, after: b, changed: stableStringify(a) !== stableStringify(b) };
    });
  }, [active, prev]);

  const changedDiff = diff.filter((d) => d.changed);
  // In "full" mode show every field; otherwise only what changed. The very
  // first entry has nothing to diff against — show all of it.
  const visibleDiff = showFull || !hasPrev ? diff : changedDiff;

  const doRevert = async (rev: { id: string }) => {
    setReverting(true);
    try {
      const r = await fetch(`/api/revisions/${encodeURIComponent(rev.id)}/revert`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        throw new Error(body?.error?.message ?? `Revert failed (${r.status})`);
      }
      setConfirmRev(null);
      toast("Reverted — a new revision was recorded.");
      await loadItems(collectionSlug);
      await loadTimeline(collectionSlug, activeId);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setReverting(false);
    }
  };

  const titleFor = (e: Entry) => (e.kind === "live" ? "Current" : `Revision v${e.v}`);
  const subtitleFor = (e: Entry) =>
    e.kind === "live"
      ? `live · updated ${fmtRevTs(String(e.snapshot.updatedAt ?? e.snapshot.updated_at ?? ""))}`
      : `${fmtRevTs(e.createdAt)} · ${e.createdBy ?? "system"}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader title="Revisions" description="Every write is versioned. Inspect, diff, or revert any prior state." />
      <div className="master-detail-3">
        <div className="card">
          <div className="card-section" style={{ fontSize: 12, fontWeight: 500 }}>Items <span className="muted font-mono" style={{ fontSize: 11 }}>· c_{collectionSlug}</span></div>
          {itemsLoading && (
            <div className="muted" style={{ padding: "16px 12px", fontSize: 12 }}>Loading…</div>
          )}
          {!itemsLoading && items.length === 0 && (
            <div className="muted" style={{ padding: "16px 12px", fontSize: 12 }}>No items in this collection yet.</div>
          )}
          {items.map((it) => (
            <div key={it.id} onClick={() => setActiveId(it.id)} style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", cursor: "pointer", background: activeId === it.id ? "var(--accent)" : "transparent" }}>
              <div style={{ fontSize: 12.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</div>
              <div className="font-mono muted" style={{ fontSize: 10.5 }}>{it.id.slice(0, 14)}…</div>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="card-section" style={{ fontSize: 12, fontWeight: 500 }}>Timeline · {item?.title?.slice(0, 18) ?? "—"}{item ? "…" : ""}</div>
          {revsLoading && (
            <div className="muted" style={{ padding: "16px 12px", fontSize: 12 }}>Loading…</div>
          )}
          {!revsLoading && entries.length === 0 && (
            <div className="muted" style={{ padding: "16px 12px", fontSize: 12 }}>{activeId ? "No revisions yet for this item." : "Select an item to see its history."}</div>
          )}
          {!revsLoading && entries.length === 1 && entries[0].kind === "live" && (
            <div className="muted" style={{ padding: "10px 12px", fontSize: 11.5, borderTop: "1px solid var(--border)" }}>Only the current state exists — no edits recorded yet.</div>
          )}
          {entries.map((e, i) => {
            const sel = activeIdx === i;
            return (
              <div key={e.kind === "live" ? "__live" : e.id} onClick={() => setActiveIdx(i)} style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", cursor: "pointer", background: sel ? "var(--accent)" : "transparent", display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="font-mono" style={{ fontSize: 12, fontWeight: 500 }}>{e.kind === "live" ? "live" : `v${e.v}`}</span>
                  <Badge variant={e.kind === "live" ? "default" : "secondary"}>{e.kind === "live" ? "current" : i === entries.length - 1 ? "initial" : "edit"}</Badge>
                </div>
                <div className="muted font-mono" style={{ fontSize: 10.5 }}>{subtitleFor(e)}</div>
              </div>
            );
          })}
        </div>
        <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          {!active ? (
            <div style={{ padding: 36, textAlign: "center", color: "var(--muted-foreground)", fontSize: 13 }}>
              {revsLoading ? "Loading…" : "Pick a revision from the timeline to inspect, diff, or revert."}
            </div>
          ) : (
          <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{titleFor(active)}</span>
            <Badge variant={active.kind === "live" ? "default" : "secondary"}>{active.kind === "live" ? "current" : !hasPrev ? "initial" : "edit"}</Badge>
            <span className="muted font-mono" style={{ fontSize: 12 }}>{subtitleFor(active)}</span>
            <div className="spacer" />
            {hasPrev && (
              <Button size="sm" variant="outline" icon={I.Eye} onClick={() => setShowFull((s) => !s)}>
                {showFull ? "Changes only" : "View full"}
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              icon={I.History}
              disabled={active.kind === "live" || reverting}
              title={active.kind === "live" ? "This is already the current state" : "Restore this snapshot"}
              onClick={() => active.kind === "rev" && setConfirmRev({ id: active.id, v: active.v, createdAt: active.createdAt })}
            >
              {reverting ? "Reverting…" : active.kind === "live" ? "Current state" : "Revert to this"}
            </Button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {!hasPrev && (
              <div className="muted" style={{ fontSize: 12 }}>
                {active.kind === "live"
                  ? "No earlier revisions — showing the current field values."
                  : "Initial revision — the first recorded state of this item."}
              </div>
            )}
            {hasPrev && (
              <div className="muted" style={{ fontSize: 11.5 }}>
                {showFull ? "Showing all fields" : `Showing ${changedDiff.length} changed field${changedDiff.length === 1 ? "" : "s"}`} · before = {titleFor(prev)}
              </div>
            )}
            {hasPrev && !showFull && changedDiff.length === 0 && (
              <div className="muted" style={{ fontSize: 12 }}>No field changes from {titleFor(prev)}.</div>
            )}
            {visibleDiff.map((d) => {
              const isAuto = REV_AUTO_FIELDS.has(d.field);
              return (
                <div key={d.field} className="card" style={{ padding: 12, borderRadius: "var(--radius-xl)", display: "flex", flexDirection: "column", gap: 8, opacity: d.changed || showFull ? 1 : 0.7 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="font-mono" style={{ fontSize: 12, fontWeight: 500 }}>{d.field}</span>
                    {isAuto && <Badge variant="outline">system</Badge>}
                    {!d.changed && <Badge variant="secondary">unchanged</Badge>}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: hasPrev ? "1fr 1fr" : "1fr", gap: 8 }}>
                    {hasPrev && (
                      <div style={{ padding: 8, background: d.changed ? "color-mix(in oklch, var(--destructive) 8%, var(--card))" : "var(--card)", border: `1px solid ${d.changed ? "color-mix(in oklch, var(--destructive) 30%, var(--border))" : "var(--border)"}`, borderRadius: "var(--radius-md)", fontFamily: "Geist Mono, monospace", fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>before</div>{fmtRevValue(d.before)}
                      </div>
                    )}
                    <div style={{ padding: 8, background: d.changed && hasPrev ? "color-mix(in oklch, oklch(0.7 0.18 145) 12%, var(--card))" : "var(--card)", border: `1px solid ${d.changed && hasPrev ? "color-mix(in oklch, oklch(0.7 0.18 145) 40%, var(--border))" : "var(--border)"}`, borderRadius: "var(--radius-md)", fontFamily: "Geist Mono, monospace", fontSize: 11.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>{hasPrev ? "after" : "value"}</div>{fmtRevValue(d.after)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          </>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={!!confirmRev}
        title={confirmRev ? `Revert to revision v${confirmRev.v}?` : "Revert?"}
        description={
          confirmRev
            ? `This rewrites the item to the v${confirmRev.v} snapshot from ${fmtRevTs(confirmRev.createdAt)}. The current state is preserved as a new revision, so this is undoable.`
            : ""
        }
        actionLabel={reverting ? "Reverting…" : "Revert"}
        onConfirm={() => confirmRev && void doRevert(confirmRev)}
        onCancel={() => { if (!reverting) setConfirmRev(null); }}
      />
    </div>
  );
}

/**
 * 12-column drag/resize grid for the Insights dashboard. Pure DOM (no
 * react-grid-layout dep) — each cell is absolute-positioned over a
 * `position: relative` container, sized by `colW` (computed from the
 * container width / 12) and a fixed row height.
 *
 * In edit mode (`editing`):
 *  - The whole tile area becomes a move handle. Mouse drag changes the
 *    tile's grid origin in 1-col / 1-row steps.
 *  - A 14×14 corner square in the bottom-right is a resize handle —
 *    same conversion, but applied to (w, h).
 *  - On mouseup the parent gets `onLayoutChange(id, layout)` and is
 *    expected to PATCH the server. While dragging we keep the active
 *    tile on a local transform so the rest of the page doesn't reflow.
 */
function DashboardGrid({
  panels,
  layouts,
  editing,
  onLayoutChange,
  renderPanel,
}: {
  panels: ApiPanel[];
  layouts: Record<string, { x: number; y: number; w: number; h: number }>;
  editing: boolean;
  onLayoutChange: (id: string, layout: { x: number; y: number; w: number; h: number }) => void;
  renderPanel: (panel: ApiPanel) => ReactNode;
}) {
  const COLS = 12;
  const ROW_H = 84;
  const GAP = 12;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // On narrow viewports the 12-column drag grid is unusable (cells get a
  // dozen pixels wide and there's no mouse for the drag handles). Fall back
  // to a single full-width column so panels stay readable; layout editing is
  // hidden upstream in that case.
  const stacked = width > 0 && width < 640;

  useLayoutEffect(() => {
    const update = () => setWidth(containerRef.current?.clientWidth ?? 0);
    update();
    if (typeof ResizeObserver === "undefined" || !containerRef.current) return;
    const obs = new ResizeObserver(update);
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [stacked]);

  const colW = width > 0 ? (width - GAP * (COLS - 1)) / COLS : 0;

  // Auto-place panels that don't have a saved layout yet — left-to-right
  // packing in 6×4 tiles. Existing layouts win.
  const finalLayouts = useMemo(() => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    let cx = 0;
    let cy = 0;
    for (const p of panels) {
      const saved = layouts[p.id];
      if (saved) {
        out[p.id] = saved;
      } else {
        out[p.id] = { x: cx, y: cy, w: 6, h: 4 };
        cx += 6;
        if (cx >= COLS) { cx = 0; cy += 4; }
      }
    }
    return out;
  }, [panels, layouts]);

  type Drag = {
    panelId: string;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    base: { x: number; y: number; w: number; h: number };
    delta: { dx: number; dy: number };
  };
  const [drag, setDrag] = useState<Drag | null>(null);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      if (colW <= 0) return;
      const dx = Math.round((e.clientX - drag.startX) / (colW + GAP));
      const dy = Math.round((e.clientY - drag.startY) / (ROW_H + GAP));
      setDrag((d) => (d ? { ...d, delta: { dx, dy } } : d));
    };
    const onUp = () => {
      const dx = drag.delta.dx;
      const dy = drag.delta.dy;
      const next = drag.mode === "move"
        ? {
            x: Math.max(0, Math.min(COLS - drag.base.w, drag.base.x + dx)),
            y: Math.max(0, drag.base.y + dy),
            w: drag.base.w,
            h: drag.base.h,
          }
        : {
            x: drag.base.x,
            y: drag.base.y,
            w: Math.max(2, Math.min(COLS - drag.base.x, drag.base.w + dx)),
            h: Math.max(2, drag.base.h + dy),
          };
      const changed =
        next.x !== drag.base.x ||
        next.y !== drag.base.y ||
        next.w !== drag.base.w ||
        next.h !== drag.base.h;
      if (changed) onLayoutChange(drag.panelId, next);
      setDrag(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // colW dependency is intentional — drag conversion uses the current width
    // so the grid stays accurate during a window resize mid-drag.
  }, [drag, colW, onLayoutChange]);

  const totalRows = panels.reduce((max, p) => {
    const l = finalLayouts[p.id]!;
    const isActive = drag?.panelId === p.id;
    const dy = isActive && drag.mode === "move" ? drag.delta.dy : 0;
    const dh = isActive && drag.mode === "resize" ? drag.delta.dy : 0;
    return Math.max(max, l.y + dy + l.h + dh);
  }, 0);
  const containerHeight = totalRows > 0 ? totalRows * ROW_H + (totalRows - 1) * GAP : 200;

  if (stacked) {
    return (
      <div ref={containerRef} style={{ display: "flex", flexDirection: "column", gap: GAP, width: "100%" }}>
        {panels.map((p) => (
          <div key={p.id} style={{ width: "100%", minWidth: 0 }}>
            {renderPanel(p)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", height: containerHeight, transition: drag ? "none" : "height 200ms ease" }}
    >
      {panels.map((p) => {
        const base = finalLayouts[p.id]!;
        const isActive = drag?.panelId === p.id;
        const dxApplied = isActive && drag.mode === "move" ? drag.delta.dx : 0;
        const dyApplied = isActive && drag.mode === "move" ? drag.delta.dy : 0;
        const dwApplied = isActive && drag.mode === "resize" ? drag.delta.dx : 0;
        const dhApplied = isActive && drag.mode === "resize" ? drag.delta.dy : 0;
        const xv = Math.max(0, Math.min(COLS - base.w, base.x + dxApplied));
        const yv = Math.max(0, base.y + dyApplied);
        const wv = Math.max(2, Math.min(COLS - xv, base.w + dwApplied));
        const hv = Math.max(2, base.h + dhApplied);
        return (
          <div
            key={p.id}
            style={{
              position: "absolute",
              left: xv * (colW + GAP),
              top: yv * (ROW_H + GAP),
              width: Math.max(0, wv * colW + (wv - 1) * GAP),
              height: hv * ROW_H + (hv - 1) * GAP,
              transition: isActive ? "none" : "left 200ms ease, top 200ms ease, width 200ms ease, height 200ms ease",
              boxShadow: isActive ? "0 8px 24px color-mix(in oklch, var(--primary) 25%, transparent)" : "none",
              zIndex: isActive ? 2 : 1,
            }}
          >
            <div style={{ position: "absolute", inset: 0, overflow: "auto", pointerEvents: editing ? "none" : "auto" }}>
              {renderPanel(p)}
            </div>
            {editing && (
              <>
                <div
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setDrag({ panelId: p.id, mode: "move", startX: e.clientX, startY: e.clientY, base, delta: { dx: 0, dy: 0 } });
                  }}
                  style={{
                    position: "absolute",
                    inset: 0,
                    cursor: "move",
                    background: "color-mix(in oklch, var(--primary) 6%, transparent)",
                    border: "1.5px dashed color-mix(in oklch, var(--primary) 55%, transparent)",
                    borderRadius: "var(--radius-md)",
                    zIndex: 3,
                  }}
                  title="Drag to move"
                >
                  <div style={{ position: "absolute", top: 6, left: 6, fontSize: 10.5, fontWeight: 500, color: "var(--primary)", background: "var(--card)", padding: "2px 6px", borderRadius: 4, display: "flex", alignItems: "center", gap: 4 }}>
                    <I.Pencil size={10} />{xv},{yv} · {wv}×{hv}
                  </div>
                </div>
                <div
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDrag({ panelId: p.id, mode: "resize", startX: e.clientX, startY: e.clientY, base, delta: { dx: 0, dy: 0 } });
                  }}
                  style={{
                    position: "absolute",
                    right: 4,
                    bottom: 4,
                    width: 16,
                    height: 16,
                    background: "var(--primary)",
                    borderRadius: 4,
                    cursor: "nwse-resize",
                    zIndex: 4,
                    boxShadow: "0 1px 2px rgba(0,0,0,0.25)",
                  }}
                  title="Drag to resize"
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function InsightsPage({ pushToast }: { pushToast?: (m: string) => void } = {}) {
  const [panels, setPanels] = useState<ApiPanel[]>([]);
  const [results, setResults] = useState<Record<string, Record<string, unknown>[]>>({});
  const [runErrors, setRunErrors] = useState<Record<string, string>>({});
  const [editor, setEditor] = useState<{ mode: "create" } | { mode: "edit"; panel: ApiPanel } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ApiPanel | null>(null);
  const [editingLayout, setEditingLayout] = useState(false);
  const isMobile = useIsMobile();
  // The drag/resize layout editor needs a pointer and a wide grid — neither
  // exists on phones, where DashboardGrid falls back to a stacked column.
  const editing = editingLayout && !isMobile;
  // Local copy of each panel's grid layout. Updated optimistically on drag/
  // resize, then PATCHed back to the server. Falls back to an auto-laid-out
  // default for panels that have never been positioned.
  type Layout = { x: number; y: number; w: number; h: number };
  const [layouts, setLayouts] = useState<Record<string, Layout>>({});

  const reload = async () => {
    try {
      const r = await panelsApi.list();
      const list = r.data ?? [];
      setPanels(list);
      // Hydrate the local layouts map from the server's authoritative copy.
      // We replace rather than merge so panels deleted server-side fall out.
      const nextLayouts: Record<string, Layout> = {};
      for (const p of list) if (p.layout) nextLayouts[p.id] = p.layout;
      setLayouts(nextLayouts);
      // Run each SQL/items-aggregate panel in parallel; static panels render
      // from their config without a server roundtrip.
      const runs = await Promise.allSettled(
        list.filter((p) => p.kind === "sql" || p.kind === "items-aggregate").map(async (p) => {
          try {
            const out = await panelsApi.run(p.id);
            return { id: p.id, data: out.data, error: null as string | null };
          } catch (e) {
            return { id: p.id, data: null, error: (e as Error).message };
          }
        }),
      );
      const data: Record<string, Record<string, unknown>[]> = {};
      const errs: Record<string, string> = {};
      for (const r of runs) {
        if (r.status !== "fulfilled") continue;
        if (r.value.error) errs[r.value.id] = r.value.error;
        else if (r.value.data) data[r.value.id] = r.value.data;
      }
      setResults(data);
      setRunErrors(errs);
    } catch {
      // leave empty
    }
  };
  useEffect(() => { void reload(); }, []);

  const saveLayout = async (id: string, layout: Layout) => {
    // Optimistic — flip the local layout immediately so the drag preview
    // doesn't jump. If the PATCH errors we surface it via toast and reload.
    setLayouts((s) => ({ ...s, [id]: layout }));
    try {
      await panelsApi.update(id, { layout });
    } catch (e) {
      pushToast?.((e as Error).message);
      void reload();
    }
  };

  const renderPanelCard = (p: ApiPanel) => (
    <RealPanel
      panel={p}
      rows={results[p.id] ?? []}
      error={runErrors[p.id] ?? null}
      onEdit={editing ? undefined : () => setEditor({ mode: "edit", panel: p })}
      onDelete={editing ? undefined : () => setConfirmDelete(p)}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="Insights"
        description="Build a panel from a collection (count / sum / average …) or a saved SQL query. Drag panels to lay out your dashboard."
        actions={
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!isMobile && (
              <Button
                variant={editing ? "primary" : "outline"}
                icon={editing ? I.Check : I.Pencil}
                onClick={() => setEditingLayout((v) => !v)}
                disabled={panels.length === 0}
              >
                {editing ? "Done" : "Edit layout"}
              </Button>
            )}
            <Button variant="primary" icon={I.Plus} onClick={() => setEditor({ mode: "create" })}>New panel</Button>
          </div>
        }
      />
      {panels.length > 0 ? (
        <DashboardGrid
          panels={panels}
          layouts={layouts}
          editing={editing}
          onLayoutChange={saveLayout}
          renderPanel={renderPanelCard}
        />
      ) : (
        <div className="card" style={{ padding: 48, textAlign: "center", color: "var(--muted-foreground)", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
          <I.BarChart size={28} className="muted" />
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--foreground)" }}>No insight panels yet</div>
          <div style={{ fontSize: 12.5, maxWidth: 460, lineHeight: 1.5 }}>
            Insight panels chart a collection aggregate (count / sum / average …) or a saved SQL query as a counter, sparkline, bars, donut, or table.
            Click <strong>+ New panel</strong> to build your first one — pick a collection, no SQL required.
          </div>
        </div>
      )}

      {editor && (
        <PanelEditorDialog
          mode={editor.mode}
          panel={editor.mode === "edit" ? editor.panel : null}
          existing={panels.map((p) => p.name)}
          onClose={() => setEditor(null)}
          onSaved={async (name, mode) => {
            setEditor(null);
            await reload();
            pushToast?.(mode === "create" ? `Panel "${name}" created.` : `Panel "${name}" saved.`);
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete ? `Delete "${confirmDelete.name}"?` : ""}
        description={
          <>
            This removes the panel from <span className="font-mono">saved_panels</span> and any dashboards that reference it.
            The query itself isn't run again. This action can't be undone.
          </>
        }
        actionLabel="Delete panel"
        destructive
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (!confirmDelete) return;
          const name = confirmDelete.name;
          try {
            await panelsApi.remove(confirmDelete.id);
            setConfirmDelete(null);
            await reload();
            pushToast?.(`Panel "${name}" deleted.`);
          } catch (e) {
            setConfirmDelete(null);
            pushToast?.((e as Error).message);
          }
        }}
      />
    </div>
  );
}

const SAMPLE_PANEL_SQL = "SELECT COUNT(*) AS n FROM user;";

type PanelKind = "sql" | "items-aggregate" | "static";
type PanelViz = "counter" | "sparkline" | "bars" | "donut" | "table";

const VIZ_DESCRIPTIONS: Record<PanelViz, string> = {
  counter: "single number",
  sparkline: "filled line over a numeric series",
  bars: "vertical bars over a numeric series",
  donut: "donut chart over up to 6 segments",
  table: "small key/value table",
};

/** Same SELECT-only check the server uses, kept in sync. */
const isReadOnlySelect = (s: string): { ok: boolean; reason?: string } => {
  const trimmed = s.trim().replace(/;$/, "");
  if (trimmed.length === 0) return { ok: false, reason: "SQL is empty." };
  if (!/^select\b/i.test(trimmed)) return { ok: false, reason: "Must start with SELECT." };
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|attach|detach)\b/i.test(trimmed)) {
    return { ok: false, reason: "Writes (INSERT / UPDATE / DELETE / DROP / …) are blocked." };
  }
  return { ok: true };
};

/**
 * Map a Zod-style ApiError details list into per-field error messages keyed by
 * the form field id. The server's PanelInput uses the same field names as the
 * dialog's state, so the path's first segment is the lookup key.
 */
const distributeApiErrors = (
  err: unknown,
): { fieldErrors: Record<string, string>; topLevel: string | null } => {
  if (!(err instanceof ApiError)) {
    return { fieldErrors: {}, topLevel: err instanceof Error ? err.message : String(err) };
  }
  const fieldErrors: Record<string, string> = {};
  let topLevel: string | null = null;
  for (const d of err.details ?? []) {
    const key = d.path?.[0];
    if (typeof key === "string" && d.message) {
      fieldErrors[key] = d.message;
    } else if (d.message) {
      topLevel = topLevel ? `${topLevel} · ${d.message}` : d.message;
    }
  }
  if (Object.keys(fieldErrors).length === 0 && !topLevel) topLevel = err.message;
  return { fieldErrors, topLevel };
};

type ItemsAggFunc = "count" | "sum" | "avg" | "min" | "max";

interface ItemsAggregateState {
  collection: string;
  agg: ItemsAggFunc;
  field: string;
  groupBy: string;
  filter: string; // raw JSON; parsed at submit
  limit: string;  // string for input control; parsed at submit
}

const DEFAULT_AGG_STATE: ItemsAggregateState = {
  collection: "",
  agg: "count",
  field: "",
  groupBy: "",
  filter: "",
  limit: "",
};

function PanelEditorDialog({
  mode,
  panel,
  existing,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  panel: ApiPanel | null;
  existing: string[];
  onClose: () => void;
  onSaved: (name: string, mode: "create" | "edit") => void;
}) {
  const [name, setName] = useState(panel?.name ?? "");
  const [description, setDescription] = useState(panel?.description ?? "");
  const [kind, setKind] = useState<PanelKind>((panel?.kind as PanelKind) ?? "items-aggregate");
  const [viz, setViz] = useState<PanelViz>((panel?.viz as PanelViz) ?? "counter");
  const [sqlText, setSqlText] = useState<string>(panel?.sql ?? SAMPLE_PANEL_SQL);
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);

  // items-aggregate state. Hydrate from panel.config if present.
  const [agg, setAgg] = useState<ItemsAggregateState>(() => {
    const cfg = (panel?.config ?? {}) as Partial<ItemsAggregateState> & { filter?: unknown };
    return {
      collection: cfg.collection ?? "",
      agg: (cfg.agg as ItemsAggFunc) ?? "count",
      field: cfg.field ?? "",
      groupBy: cfg.groupBy ?? "",
      filter: cfg.filter ? JSON.stringify(cfg.filter, null, 2) : "",
      limit: cfg.limit !== undefined ? String(cfg.limit) : "",
    };
  });

  // Collections list for the items-aggregate selectors. Loaded once on mount;
  // per-collection schema is fetched on demand below.
  const [collections, setCollections] = useState<ApiCollection[]>([]);
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const [collectionSchema, setCollectionSchema] = useState<ApiCollection | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await collectionsApi.list();
        if (!cancelled) setCollections(r.data ?? []);
      } catch { /* leave empty; the editor will show a hint */ }
      finally { if (!cancelled) setCollectionsLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!agg.collection) { setCollectionSchema(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const r = await collectionsApi.get(agg.collection);
        if (!cancelled) setCollectionSchema(r.data ?? null);
      } catch { setCollectionSchema(null); }
    })();
    return () => { cancelled = true; };
  }, [agg.collection]);

  // Live preview state.
  type PreviewResult = { rows: Record<string, unknown>[]; ms: number };
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const trimmedName = name.trim();
  const otherNames = mode === "edit" && panel ? existing.filter((n) => n !== panel.name) : existing;
  const nameError =
    serverErrors.name ??
    (trimmedName.length === 0
      ? "Required."
      : trimmedName.length > 80
        ? "Max 80 characters."
        : otherNames.includes(trimmedName)
          ? "A panel with that name already exists."
          : null);

  const sqlCheck = isReadOnlySelect(sqlText);
  const sqlError =
    serverErrors.sql ??
    (kind === "sql" && !sqlCheck.ok ? sqlCheck.reason ?? "Invalid SQL." : null);

  const descError = serverErrors.description ?? (description.length > 500 ? "Max 500 characters." : null);

  // items-aggregate validation. Field/groupBy must reference real columns;
  // sum/avg/min/max require a numeric field; filter must parse as JSON.
  const numericFields = (collectionSchema?.fields ?? []).filter((f) => f.type === "integer" || f.type === "number");
  const allFieldsList = (collectionSchema?.fields ?? []).map((f) => f.name);
  const SYSTEM_GROUP_COLUMNS = ["created_at", "updated_at", "owner_id"];
  const groupByOptions = ["", ...allFieldsList, ...SYSTEM_GROUP_COLUMNS];
  let aggError: { collection?: string; agg?: string; field?: string; groupBy?: string; filter?: string; limit?: string } = {};
  if (kind === "items-aggregate") {
    if (!agg.collection) aggError.collection = "Required.";
    if (agg.agg !== "count") {
      if (!agg.field) aggError.field = "Required for sum/avg/min/max.";
      else if (numericFields.length > 0 && !numericFields.some((f) => f.name === agg.field)) {
        aggError.field = "Must be an integer or number column.";
      }
    }
    if (agg.groupBy && !groupByOptions.includes(agg.groupBy)) {
      aggError.groupBy = `"${agg.groupBy}" is not a column on this collection.`;
    }
    if (agg.filter.trim()) {
      try {
        const parsed = JSON.parse(agg.filter);
        if (typeof parsed !== "object" || parsed === null) {
          aggError.filter = "Must be a JSON object.";
        }
      } catch (e) {
        aggError.filter = `JSON parse error: ${(e as Error).message}`;
      }
    }
    if (agg.limit && (!/^\d+$/.test(agg.limit) || Number(agg.limit) < 1 || Number(agg.limit) > 200)) {
      aggError.limit = "Integer between 1 and 200.";
    }
  }
  // Merge server-side aggregate errors back in (server returns flat strings).
  if (serverErrors.config) aggError = { ...aggError, agg: serverErrors.config };

  const valid =
    !nameError &&
    !descError &&
    (kind !== "sql" || !sqlError) &&
    (kind !== "items-aggregate" || Object.keys(aggError).length === 0);

  // One-line "what feeds the chart" hint shown under the Visualization picker.
  const vizHint =
    kind === "items-aggregate"
      ? agg.groupBy
        ? `One row per "${agg.groupBy}" — bars / donut / table show the breakdown; counter shows only the first.`
        : "A single value — counter fits best; sparkline / bars need multiple rows."
      : kind === "sql"
        ? "Counter takes the first numeric column of row 1; sparkline / bars plot it across all rows; donut / table pair the first two columns."
        : `${VIZ_DESCRIPTIONS[viz]}.`;

  /** Compose the items-aggregate config payload. Returns null if not applicable. */
  const composeAggregateConfig = (): Record<string, unknown> | null => {
    if (kind !== "items-aggregate") return null;
    const cfg: Record<string, unknown> = {
      collection: agg.collection,
      agg: agg.agg,
    };
    if (agg.agg !== "count" && agg.field) cfg.field = agg.field;
    if (agg.groupBy) cfg.groupBy = agg.groupBy;
    if (agg.filter.trim()) cfg.filter = JSON.parse(agg.filter);
    if (agg.limit) cfg.limit = Number(agg.limit);
    return cfg;
  };

  const clearServerError = (key: string) => {
    if (!serverErrors[key]) return;
    setServerErrors((s) => {
      const next = { ...s };
      delete next[key];
      return next;
    });
  };

  const runPreview = async () => {
    if (kind === "sql") {
      if (!sqlCheck.ok) {
        setPreview(null);
        setPreviewError(sqlCheck.reason ?? "Invalid SQL.");
        return;
      }
      setPreviewBusy(true);
      setPreviewError(null);
      try {
        const start = performance.now();
        const r = await dbAdminApi.runSql(sqlText);
        const last = r.data?.[r.data.length - 1];
        const rows = (last?.rows ?? []) as Record<string, unknown>[];
        setPreview({ rows, ms: r.ms ?? Math.round(performance.now() - start) });
      } catch (e) {
        setPreview(null);
        setPreviewError((e as Error).message);
      } finally {
        setPreviewBusy(false);
      }
      return;
    }
    if (kind === "items-aggregate") {
      if (Object.keys(aggError).length > 0) {
        setPreview(null);
        const first = Object.values(aggError)[0];
        setPreviewError(first ?? "Invalid aggregate config.");
        return;
      }
      const cfg = composeAggregateConfig();
      if (!cfg) return;
      setPreviewBusy(true);
      setPreviewError(null);
      try {
        const r = await panelsApi.preview({ kind: "items-aggregate", config: cfg });
        setPreview({ rows: r.data ?? [], ms: r.ms ?? 0 });
      } catch (e) {
        setPreview(null);
        setPreviewError((e as Error).message);
      } finally {
        setPreviewBusy(false);
      }
    }
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setServerErrors({});
    setTopError(null);
    try {
      const body = {
        name: trimmedName,
        description: description.trim() || null,
        kind,
        sql: kind === "sql" ? sqlText : null,
        viz,
        config: kind === "items-aggregate" ? composeAggregateConfig() : null,
        layout: null,
      };
      if (mode === "create") {
        await panelsApi.create(body);
      } else if (panel) {
        await panelsApi.update(panel.id, body);
      }
      onSaved(trimmedName, mode);
    } catch (e) {
      const { fieldErrors, topLevel } = distributeApiErrors(e);
      setServerErrors(fieldErrors);
      setTopError(topLevel);
    } finally {
      setBusy(false);
    }
  };

  const titleId = "panel-editor-title";

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 720, maxWidth: "94vw", maxHeight: "90vh", display: "flex", flexDirection: "column" }}
      >
        <div className="sheet-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1 }}>
            <h2 id={titleId}>{mode === "create" ? "New insight panel" : `Edit panel`}</h2>
            <p>
              {mode === "create"
                ? <>Saved as a row in <span className="font-mono">saved_panels</span>. Collection panels aggregate one collection (count / sum / average …); SQL panels run a read-only SELECT against the workspace database.</>
                : <>Editing <span className="font-mono">{panel?.id}</span>.</>}
            </p>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>

        <div className="dialog-body" style={{ overflow: "auto" }}>
          {topError && (
            <div className="field" style={{ background: "color-mix(in oklch, var(--destructive) 8%, var(--card))", border: "1px solid color-mix(in oklch, var(--destructive) 35%, var(--border))", padding: 10, borderRadius: "var(--radius-md)", color: "var(--destructive)", fontSize: 12.5, display: "flex", gap: 8, alignItems: "flex-start" }}>
              <I.AlertTriangle size={13} style={{ marginTop: 1, flex: "0 0 auto" }} />
              <span style={{ flex: 1, wordBreak: "break-word" }}>{topError}</span>
            </div>
          )}

          <div className="field">
            <label className="field-label" htmlFor="panel-name">
              Name <span style={{ color: "var(--destructive)" }}>*</span>
            </label>
            <input
              id="panel-name"
              className={`input ${nameError && (name || serverErrors.name) ? "error" : ""}`}
              autoFocus
              autoComplete="off"
              placeholder="Active users (24h)"
              value={name}
              onChange={(e) => { setName(e.target.value); clearServerError("name"); }}
            />
            {nameError && (name || serverErrors.name) ? (
              <div className="field-error"><I.AlertTriangle size={11} />{nameError}</div>
            ) : (
              <span className="field-hint">Shown as the panel title on the dashboard.</span>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="panel-desc">
              Description <span className="muted" style={{ fontWeight: 400 }}>· optional</span>
            </label>
            <input
              id="panel-desc"
              className={`input ${descError ? "error" : ""}`}
              autoComplete="off"
              placeholder="Distinct users with a session in the last 24h"
              value={description}
              onChange={(e) => { setDescription(e.target.value); clearServerError("description"); }}
            />
            {descError && <div className="field-error"><I.AlertTriangle size={11} />{descError}</div>}
          </div>

          <div className="cols-2">
            <div className="field">
              <label className="field-label">Kind</label>
              <Select
                value={kind}
                onChange={(v) => { setKind(v as PanelKind); setPreview(null); setPreviewError(null); clearServerError("kind"); }}
                options={[
                  { value: "items-aggregate", label: "collection", hint: "count / sum / average over a collection — no SQL" },
                  { value: "sql", label: "sql", hint: "read-only SELECT against the workspace database" },
                  { value: "static", label: "static", hint: "config-only panel rendered from props" },
                ]}
              />
              {serverErrors.kind
                ? <div className="field-error"><I.AlertTriangle size={11} />{serverErrors.kind}</div>
                : <span className="field-hint">{kind === "items-aggregate" ? "Pick a collection and an aggregate below — no query to write." : kind === "sql" ? "Write a read-only SELECT below." : "Set the config object via the API once the panel exists."}</span>}
            </div>
            <div className="field">
              <label className="field-label">Visualization</label>
              <Select
                value={viz}
                onChange={(v) => { setViz(v as PanelViz); clearServerError("viz"); }}
                options={(Object.keys(VIZ_DESCRIPTIONS) as PanelViz[]).map((v) => ({
                  value: v,
                  label: v,
                  hint: VIZ_DESCRIPTIONS[v],
                }))}
              />
              {serverErrors.viz
                ? <div className="field-error"><I.AlertTriangle size={11} />{serverErrors.viz}</div>
                : <span className="field-hint">{vizHint}</span>}
            </div>
          </div>

          {kind === "sql" && (
            <>
              <div className="field">
                <label className="field-label" htmlFor="panel-sql">
                  SQL <Badge variant="outline" mono>SELECT only</Badge> <span style={{ color: "var(--destructive)" }}>*</span>
                  <div style={{ flex: 1 }} />
                  <Button
                    size="sm"
                    variant="outline"
                    icon={I.Play}
                    onClick={runPreview}
                    disabled={previewBusy || !sqlCheck.ok}
                    style={{ marginLeft: "auto", float: "right" }}
                  >
                    {previewBusy ? "Running…" : "Run preview"}
                  </Button>
                </label>
                <textarea
                  id="panel-sql"
                  className={`textarea font-mono ${sqlError ? "error" : ""}`}
                  style={{ minHeight: 140, fontSize: 12, whiteSpace: "pre" }}
                  spellCheck={false}
                  value={sqlText}
                  onChange={(e) => { setSqlText(e.target.value); clearServerError("sql"); setPreviewError(null); }}
                />
                {sqlError ? (
                  <div className="field-error"><I.AlertTriangle size={11} />{sqlError}</div>
                ) : (
                  <span className="field-hint">
                    The query runs verbatim. The visualization hint above explains how its columns map to the chart.
                  </span>
                )}
              </div>

              <PreviewBlock viz={viz} preview={preview} previewError={previewError} />
            </>
          )}

          {kind === "items-aggregate" && (
            <>
              <div className="cols-2">
                <div className="field">
                  <label className="field-label">Collection <span style={{ color: "var(--destructive)" }}>*</span></label>
                  <Select
                    value={agg.collection}
                    onChange={(v) => setAgg((s) => ({ ...s, collection: v, field: "", groupBy: "" }))}
                    placeholder={collections.length === 0 ? "No collections" : "Pick a collection…"}
                    options={collections.map((c) => ({ value: c.slug, label: c.slug, hint: `${c.fields.length} fields` }))}
                  />
                  {aggError.collection && collections.length > 0 && <div className="field-error"><I.AlertTriangle size={11} />{aggError.collection}</div>}
                  {collectionsLoaded && collections.length === 0 && (
                    <span className="field-hint">No collections in this workspace yet — create one first, or switch <strong>Kind</strong> to <span className="font-mono">sql</span>.</span>
                  )}
                </div>
                <div className="field">
                  <label className="field-label">Aggregate function</label>
                  <Select
                    value={agg.agg}
                    onChange={(v) => setAgg((s) => ({ ...s, agg: v as ItemsAggFunc, field: v === "count" ? "" : s.field }))}
                    options={[
                      { value: "count", label: "count", hint: "row count (no field needed)" },
                      { value: "sum", label: "sum", hint: "numeric column total" },
                      { value: "avg", label: "avg", hint: "numeric column average" },
                      { value: "min", label: "min", hint: "numeric column minimum" },
                      { value: "max", label: "max", hint: "numeric column maximum" },
                    ]}
                  />
                </div>
              </div>

              <div className="cols-2">
                <div className="field">
                  <label className="field-label">
                    Field {agg.agg !== "count" && <span style={{ color: "var(--destructive)" }}>*</span>}
                  </label>
                  <Select
                    value={agg.field}
                    onChange={(v) => setAgg((s) => ({ ...s, field: v }))}
                    placeholder={agg.agg === "count" ? "Not needed for count" : numericFields.length === 0 ? "No numeric columns" : "Pick a numeric field…"}
                    disabled={agg.agg === "count" || !agg.collection || numericFields.length === 0}
                    options={numericFields.map((f) => ({ value: f.name, label: f.name, hint: f.type }))}
                  />
                  {aggError.field && <div className="field-error"><I.AlertTriangle size={11} />{aggError.field}</div>}
                </div>
                <div className="field">
                  <label className="field-label">Group by <span className="muted" style={{ fontWeight: 400 }}>· optional</span></label>
                  <Select
                    value={agg.groupBy}
                    onChange={(v) => setAgg((s) => ({ ...s, groupBy: v }))}
                    placeholder={!agg.collection ? "Pick a collection first" : "(none)"}
                    disabled={!agg.collection}
                    options={[
                      { value: "", label: "(none)", hint: "single scalar value" },
                      ...allFieldsList.map((n) => ({ value: n, label: n })),
                      ...SYSTEM_GROUP_COLUMNS.map((n) => ({ value: n, label: n, hint: "system" })),
                    ]}
                  />
                  {aggError.groupBy && <div className="field-error"><I.AlertTriangle size={11} />{aggError.groupBy}</div>}
                </div>
              </div>

              <div className="field">
                <label className="field-label">
                  Filter <Badge variant="outline" mono>JSON DSL</Badge> <span className="muted" style={{ fontWeight: 400 }}>· optional</span>
                </label>
                <textarea
                  className={`textarea font-mono ${aggError.filter ? "error" : ""}`}
                  style={{ minHeight: 80, fontSize: 12, whiteSpace: "pre" }}
                  spellCheck={false}
                  placeholder={`{ "status": { "_eq": "published" } }`}
                  value={agg.filter}
                  onChange={(e) => setAgg((s) => ({ ...s, filter: e.target.value }))}
                />
                {aggError.filter ? (
                  <div className="field-error"><I.AlertTriangle size={11} />{aggError.filter}</div>
                ) : (
                  <span className="field-hint">
                    Same DSL as roles &amp; permissions. Operators: <span className="font-mono">_eq</span>, <span className="font-mono">_in</span>, <span className="font-mono">_gte</span>, … Variables: <span className="font-mono">$user.id</span>, <span className="font-mono">$now</span>, …
                  </span>
                )}
              </div>

              {agg.groupBy && (
                <div className="field">
                  <label className="field-label">Limit <span className="muted" style={{ fontWeight: 400 }}>· optional</span></label>
                  <input
                    className={`input tabular-nums ${aggError.limit ? "error" : ""}`}
                    type="number"
                    min={1}
                    max={200}
                    placeholder="50"
                    value={agg.limit}
                    onChange={(e) => setAgg((s) => ({ ...s, limit: e.target.value }))}
                  />
                  {aggError.limit ? (
                    <div className="field-error"><I.AlertTriangle size={11} />{aggError.limit}</div>
                  ) : (
                    <span className="field-hint">Caps the number of grouped rows returned (default 50, max 200).</span>
                  )}
                </div>
              )}

              <div className="field" style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button
                  size="sm"
                  variant="outline"
                  icon={I.Play}
                  onClick={runPreview}
                  disabled={previewBusy || Object.keys(aggError).length > 0 || !agg.collection}
                >
                  {previewBusy ? "Running…" : "Run preview"}
                </Button>
              </div>

              <PreviewBlock viz={viz} preview={preview} previewError={previewError} />
            </>
          )}

          {kind === "static" && (
            <div className="field" style={{ background: "var(--muted)", padding: 12, borderRadius: "var(--radius-xl)", fontSize: 12.5, color: "var(--muted-foreground)", display: "flex", gap: 8, alignItems: "flex-start" }}>
              <I.AlertTriangle size={12} style={{ marginTop: 2, flex: "0 0 auto" }} />
              <span>static panels render their config object verbatim — set it from the API once the panel exists.</span>
            </div>
          )}
        </div>

        <div className="sheet-footer">
          <div className="spacer" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" icon={mode === "create" ? I.Plus : I.Save} onClick={submit} disabled={!valid || busy}>
            {busy ? (mode === "create" ? "Creating…" : "Saving…") : mode === "create" ? "Create panel" : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PreviewTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Object.keys(rows[0] ?? {}).slice(0, 6);
  const max = 5;
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--card)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} className="font-mono" style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--muted-foreground)", fontWeight: 500 }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className="font-mono" style={{ padding: "6px 8px", borderTop: i === 0 ? "none" : "1px solid var(--border)", whiteSpace: "nowrap", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r[c] === null || r[c] === undefined ? <span className="muted">∅</span> : typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <div className="muted" style={{ padding: "6px 8px", fontSize: 11, borderTop: "1px solid var(--border)" }}>… and {rows.length - max} more</div>}
    </div>
  );
}

/**
 * Concrete "this column drives the chart" line, given the rows a preview/run
 * actually returned. Mirrors the auto-detection in RealPanel so the editor and
 * the dashboard agree on what each viz reads.
 */
function describeVizMapping(viz: PanelViz, rows: Record<string, unknown>[]): string {
  const first = rows[0] ?? {};
  const cols = Object.keys(first);
  const numericCol = cols.find((c) => typeof first[c] === "number");
  const labelCol = cols.find((c) => c !== numericCol);
  if (viz === "counter") {
    return numericCol
      ? `Counter → "${numericCol}" from the first row (${Number(first[numericCol]).toLocaleString()}).`
      : `Counter → no numeric column, so it shows the row count (${rows.length}).`;
  }
  if (viz === "sparkline" || viz === "bars") {
    const col = numericCol ?? cols[0];
    const label = viz === "bars" ? "Bars" : "Sparkline";
    return col
      ? `${label} → "${col}" across all ${rows.length} row${rows.length === 1 ? "" : "s"}.`
      : `${label} → the first numeric column across all rows.`;
  }
  // donut | table
  const lc = labelCol ?? cols[0];
  const vc = numericCol ?? cols[1];
  const label = viz === "donut" ? "Donut" : "Table";
  return lc && vc
    ? `${label} → "${lc}" (label) paired with "${vc}" (value).`
    : `${label} → the first two columns: label, then value.`;
}

/** Shared preview panel for the editor (SQL + collection kinds use the same UI). */
function PreviewBlock({
  viz,
  preview,
  previewError,
}: {
  viz: PanelViz;
  preview: { rows: Record<string, unknown>[]; ms: number } | null;
  previewError: string | null;
}) {
  if (!preview && !previewError) return null;
  return (
    <div className="field" style={{ background: "var(--muted)", padding: 10, borderRadius: "var(--radius-md)" }}>
      <div className="field-label" style={{ marginBottom: 6 }}>
        {previewError
          ? <><I.AlertTriangle size={12} style={{ color: "var(--destructive)" }} /> Preview error</>
          : <><I.Activity size={12} /> Preview · {preview?.rows.length ?? 0} rows · {preview?.ms ?? 0}ms</>}
      </div>
      {previewError ? (
        <div className="font-mono" style={{ fontSize: 11.5, color: "var(--destructive)", whiteSpace: "pre-wrap" }}>{previewError}</div>
      ) : preview && preview.rows.length > 0 ? (
        <>
          <PreviewTable rows={preview.rows} />
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
            <I.BarChart size={11} style={{ flex: "0 0 auto" }} />
            <span>{describeVizMapping(viz, preview.rows)}</span>
          </div>
        </>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>No rows returned.</div>
      )}
    </div>
  );
}

/** One-line summary of what a saved panel shows, used as the card subtitle when
 *  the author didn't write a description. */
function panelSubtitle(panel: ApiPanel, rowCount: number): string {
  if (panel.description) return panel.description;
  if (panel.kind === "items-aggregate") {
    const cfg = (panel.config ?? {}) as { collection?: string; agg?: string; field?: string; groupBy?: string };
    const fn = !cfg.agg || cfg.agg === "count" ? "count" : `${cfg.agg}(${cfg.field ?? "?"})`;
    return `${cfg.collection ?? "collection"} · ${fn}${cfg.groupBy ? ` by ${cfg.groupBy}` : ""}`;
  }
  if (panel.kind === "sql") return `${rowCount} row${rowCount === 1 ? "" : "s"} · sql`;
  return panel.kind;
}

/**
 * Renders a saved panel using its viz config and the rows returned by
 * /api/admin/panels/:id/run. We pick the first numeric column for sparkline
 * /bars/counter, pair the first two columns for table/donut, and fall back
 * to JSON for anything we can't auto-detect.
 */
function RealPanel({
  panel,
  rows,
  error,
  onEdit,
  onDelete,
}: {
  panel: ApiPanel;
  rows: Record<string, unknown>[];
  error?: string | null;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const sub = panelSubtitle(panel, rows.length);

  if (error) {
    return (
      <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--radius-md)", background: "color-mix(in oklch, var(--destructive) 8%, var(--card))", border: "1px solid color-mix(in oklch, var(--destructive) 35%, var(--border))", color: "var(--destructive)", fontSize: 12 }}>
          <I.AlertTriangle size={13} style={{ marginTop: 1, flex: "0 0 auto" }} />
          <span style={{ flex: 1, wordBreak: "break-word" }}>{error}</span>
        </div>
      </Panel>
    );
  }

  if (rows.length === 0) {
    return (
      <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
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
      <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
        <div className="tabular-nums" style={{ fontSize: 32, fontWeight: 600, padding: "8px 0" }}>
          {v.toLocaleString()}
        </div>
      </Panel>
    );
  }

  if (panel.viz === "sparkline" || panel.viz === "bars") {
    const data = rows.map((r) => Number(r[numericCol ?? cols[0]!]) || 0);
    return (
      <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
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
      <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
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
    <Panel title={panel.name} sub={sub} onEdit={onEdit} onDelete={onDelete}>
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

function Panel({
  title,
  sub,
  children,
  onEdit,
  onDelete,
}: {
  title: string;
  sub: string;
  children: ReactNode;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{title}</span>
        <span className="muted" style={{ fontSize: 11.5, flex: 1 }}>{sub}</span>
        {onEdit && <IconButton icon={I.Pencil} onClick={onEdit} title="Edit panel" />}
        {onDelete && <IconButton icon={I.Trash} onClick={onDelete} title="Delete panel" />}
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
  type Tpl = { id: string; key: string; name: string; subject: string; vars: string[]; bodyHtml?: string; fromAddress?: string | null; isNew?: boolean };
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [active, setActive] = useState<Tpl | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [saving, setSaving] = useState(false);

  const loadInto = (t: Tpl) => {
    setActive(t);
    setKeyDraft(t.key);
    setName(t.name);
    setSubject(t.subject);
    setBody(t.bodyHtml ?? "");
    setFromAddress(t.fromAddress ?? "");
  };

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
            fromAddress: t.fromAddress,
          }));
          setTemplates(mapped);
          if (mapped[0]) loadInto(mapped[0]);
        }
      } catch {
        // leave templates empty
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSelect = async (t: Tpl) => {
    loadInto(t);
    if (t.bodyHtml !== undefined || t.isNew) return;
    try {
      const res = await emailTemplatesApi.get(t.id);
      setBody(res.data.bodyHtml);
      setFromAddress(res.data.fromAddress ?? "");
      setTemplates((arr) => arr.map((x) => x.id === t.id ? { ...x, bodyHtml: res.data.bodyHtml, fromAddress: res.data.fromAddress } : x));
    } catch {
      // keep current body
    }
  };

  const onNew = () => {
    loadInto({ id: crypto.randomUUID(), key: "", name: "", subject: "", vars: [], bodyHtml: "", isNew: true });
  };

  const onSave = async () => {
    if (!active || saving) return;
    const trimmedKey = keyDraft.trim();
    const trimmedName = name.trim();
    const trimmedFrom = fromAddress.trim();
    if (active.isNew) {
      if (!/^[a-z0-9_-]{2,40}$/i.test(trimmedKey)) { pushToast("Key must be 2–40 chars (letters, digits, dash, underscore)."); return; }
      if (templates.some((t) => !t.isNew && t.key === trimmedKey)) { pushToast(`A template with key "${trimmedKey}" already exists.`); return; }
    }
    if (!subject.trim()) { pushToast("Subject is required."); return; }
    setSaving(true);
    try {
      if (active.isNew) {
        const res = await emailTemplatesApi.create({
          key: trimmedKey,
          name: trimmedName || trimmedKey,
          subject,
          fromAddress: trimmedFrom || null,
          bodyHtml: body,
          bodyText: null,
          variables: active.vars,
        });
        const saved: Tpl = { id: res.data.id, key: res.data.key, name: res.data.name, subject: res.data.subject, vars: res.data.variables ?? [], bodyHtml: res.data.bodyHtml, fromAddress: res.data.fromAddress };
        setTemplates((arr) => [saved, ...arr.filter((t) => t.id !== active.id)]);
        loadInto(saved);
      } else {
        const newName = trimmedName || active.name;
        const fromVal = trimmedFrom || null;
        await emailTemplatesApi.patch(active.id, { name: newName, subject, bodyHtml: body, fromAddress: fromVal });
        const patch = { name: newName, subject, bodyHtml: body, fromAddress: fromVal };
        setTemplates((arr) => arr.map((t) => t.id === active.id ? { ...t, ...patch } : t));
        setActive((a) => a ? { ...a, ...patch } : a);
        setName(newName);
      }
      pushToast("Template saved.");
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onSendTest = async () => {
    if (!active) return;
    if (active.isNew) { pushToast("Save the template before sending a test."); return; }
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
      <PageHeader title="Email templates" description={<>Variables use Liquid-style <span className="font-mono">{"{{ user.email }}"}</span>. Template renders run through the Functions sandbox.</>} actions={<Button size="sm" variant="outline" icon={I.Plus} onClick={onNew}>New template</Button>} />
      <div className="master-detail-3" style={{ "--md-a": "240px", "--md-b": "minmax(0, 1fr)" }}>
        <div className="card">
          {templates.length === 0 && !active?.isNew && (
            <div className="muted" style={{ padding: "12px 14px", fontSize: 12 }}>No templates yet — use “New template” to add one.</div>
          )}
          {active?.isNew && !templates.some((t) => t.id === active.id) && (
            <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border)", background: "var(--accent)" }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>{name.trim() || "(new template)"}</div>
              <div className="font-mono muted" style={{ fontSize: 11 }}>{keyDraft.trim() || "unsaved"}</div>
            </div>
          )}
          {templates.map((t) => (
            <div key={t.id} onClick={() => void onSelect(t)} style={{ padding: "10px 12px", borderTop: "1px solid var(--border)", cursor: "pointer", background: active?.id === t.id ? "var(--accent)" : "transparent" }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t.name || "(unnamed)"}</div>
              <div className="font-mono muted" style={{ fontSize: 11 }}>{t.key || t.id}</div>
            </div>
          ))}
        </div>
        <div className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 500 }}>Editor</span>
            <div className="spacer" />
            <Button size="sm" variant="outline" icon={I.Mail} onClick={onSendTest} disabled={!active || active.isNew}>Send test</Button>
            <Button size="sm" variant="primary" icon={I.Save} onClick={onSave} disabled={!active || saving}>Save</Button>
          </div>
          <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <div className="field" style={{ flex: 1 }}><label className="field-label">Name</label><input className="input" value={name} placeholder="Verify email" onChange={(e) => setName(e.target.value)} /></div>
              <div className="field" style={{ flex: 1 }}><label className="field-label">Key</label><input className="input font-mono" value={keyDraft} placeholder="verify" disabled={!active?.isNew} spellCheck={false} autoComplete="off" onChange={(e) => setKeyDraft(e.target.value)} /></div>
            </div>
            <div className="field"><label className="field-label">Subject</label><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
            <div className="field"><label className="field-label">From</label><input className="input" value={fromAddress} placeholder="(use the configured default)" onChange={(e) => setFromAddress(e.target.value)} /></div>
            <div className="field">
              <label className="field-label">Body (HTML)</label>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} style={{ width: "100%", minHeight: 220, padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", background: "oklch(0.18 0.01 130)", color: "oklch(0.92 0.02 130)", fontFamily: "Geist Mono, monospace", fontSize: 12.5, lineHeight: 1.55, resize: "vertical" }} />
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(active?.vars ?? []).map((v) => (
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
  const [data, setData] = useState<Record<string, string>[]>([]);
  const [base, setBase] = useState("en");
  const [showOnly, setShowOnly] = useState("all");
  const [addOpen, setAddOpen] = useState(false);

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
        // leave translations empty
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const persist = (key: string, locale: string, value: string) => {
    void i18nApi.upsert(key, locale, value).catch((e: Error) => pushToast?.(e.message));
  };
  const visible = showOnly === "missing" ? data.filter((r) => locales.some((l) => !r[l])) : data;
  const completion = locales.map((l) => ({ l, pct: data.length === 0 ? 0 : Math.round(data.filter((r) => r[l]).length / data.length * 100) }));
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
          <Button variant="primary" icon={I.Plus} onClick={() => setAddOpen(true)}>New key</Button>
        </>}
      />
      {addOpen && (
        <AddTranslationKeyDialog
          base={base}
          locales={[...locales]}
          existingKeys={data.map((r) => r.key)}
          onClose={() => setAddOpen(false)}
          onCreate={async ({ key, value }) => {
            const seed: Record<string, string> = { key };
            for (const l of locales) seed[l] = "";
            if (value) seed[base] = value;
            setData((arr) => [...arr, seed]);
            try {
              await i18nApi.upsert(key, base, value);
              pushToast(value ? `Key "${key}" added with ${base} value.` : `Key "${key}" added.`);
            } catch (e) {
              pushToast((e as Error).message);
            }
            setAddOpen(false);
          }}
        />
      )}
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

interface AddTranslationKeyDialogProps {
  base: string;
  locales: string[];
  existingKeys: string[];
  onClose: () => void;
  onCreate: (input: { key: string; value: string }) => Promise<void>;
}

function AddTranslationKeyDialog({ base, locales, existingKeys, onClose, onCreate }: AddTranslationKeyDialogProps) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const trimmedKey = key.trim();
  const duplicate = useMemo(
    () => existingKeys.includes(trimmedKey),
    [existingKeys, trimmedKey],
  );
  const tooLong = trimmedKey.length > 120;
  const badFormat = trimmedKey.length > 0 && !I18N_KEY_PATTERN.test(trimmedKey);
  const error = !trimmedKey
    ? null
    : duplicate
      ? "A key with this name already exists."
      : tooLong
        ? "Key must be 120 characters or fewer."
        : badFormat
          ? "Use letters, digits, dots, dashes, or underscores. Must start with a letter or digit."
          : null;
  const valid = trimmedKey.length > 0 && !error;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await onCreate({ key: trimmedKey, value: value.trim() });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog-lg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-i18n-key-title"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 480, maxWidth: "92vw" }}
      >
        <div className="sheet-header" style={{ borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1 }}>
            <h2 id="add-i18n-key-title">New translation key</h2>
            <p>Adds a row to <span className="font-mono">i18n_strings</span>. The key is shared across all locales; values are filled per locale.</p>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>
        <div className="dialog-body">
          <div className="field">
            <label className="field-label" htmlFor="i18n-new-key">
              Key <Badge variant="outline" mono>text</Badge> <span style={{ color: "var(--destructive)" }}>*</span>
            </label>
            <input
              id="i18n-new-key"
              className={`input font-mono ${error ? "error" : ""}`}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="common.cancel"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid && !submitting) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            {error ? (
              <div className="field-error"><I.AlertTriangle size={11} />{error}</div>
            ) : (
              <div className="field-hint">Dotted namespaces are conventional, e.g. <span className="font-mono">common.cancel</span>, <span className="font-mono">auth.signin.title</span>.</div>
            )}
          </div>

          <div className="field">
            <label className="field-label" htmlFor="i18n-new-value">
              Base value <Badge variant="outline" mono>{base}</Badge> <span className="muted" style={{ fontWeight: 400 }}>· optional</span>
            </label>
            <textarea
              id="i18n-new-value"
              className="textarea"
              rows={2}
              placeholder={`Translation for ${base}`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <div className="field-hint">Leave blank to create the key with empty values across all locales.</div>
          </div>

          <div className="field" style={{ background: "var(--muted)", padding: 12, borderRadius: "var(--radius-xl)" }}>
            <div className="field-label" style={{ marginBottom: 6 }}>
              <I.Globe size={12} /> Locales
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {locales.map((l) => (
                <Badge key={l} variant={l === base ? "default" : "outline"} mono>
                  {l}{l === base && " · base"}
                </Badge>
              ))}
            </div>
            <div className="field-hint" style={{ marginTop: 6 }}>
              Other locales stay empty until filled in the matrix.
            </div>
          </div>
        </div>
        <div className="sheet-footer">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" icon={I.Plus} onClick={submit} disabled={!valid || submitting}>
            {submitting ? "Creating…" : "Create key"}
          </Button>
        </div>
      </div>
    </div>
  );
}
