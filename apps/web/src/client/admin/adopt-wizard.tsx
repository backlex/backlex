// @ts-nocheck
// Collection adoption wizard — turn an existing physical table into a
// workeros collection. 3 steps:
//   1) pick a table (GET /api/admin/adopt/tables)
//   2) map columns to FieldType (POST /api/admin/adopt/inspect)
//   3) metadata + dry-run summary → POST /api/admin/adopt/apply
//
// No DDL is run on the user's table — adoption only writes the collection
// metadata row + per-field registrations. System-column toggles set flags
// only; the backend decides whether to backfill anything later.
import { useEffect, useMemo, useState } from "react";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { I } from "./icons";
import { Select } from "./select";
import { Badge, Button, IconButton, Switch } from "./ui";

// Mirrors packages/db/src/field-types.ts FieldType union — keep in sync if
// the registry grows.
type FieldType =
  | "text"
  | "longtext"
  | "integer"
  | "number"
  | "boolean"
  | "json"
  | "timestamp"
  | "uuid";

const FIELD_TYPE_OPTIONS: { value: FieldType; label: string }[] = [
  { value: "text", label: "text" },
  { value: "longtext", label: "longtext" },
  { value: "integer", label: "integer" },
  { value: "number", label: "number" },
  { value: "boolean", label: "boolean" },
  { value: "json", label: "json" },
  { value: "timestamp", label: "timestamp" },
  { value: "uuid", label: "uuid" },
];

interface TableRow {
  name: string;
  columns: number;
  rowCount: number;
  disabled?: string | null;
}

interface InspectColumn {
  name: string;
  dbType: string;
  nullable: boolean;
  suggested: FieldType | null;
  isPk: boolean;
  reserved?: string | null;
}

interface InspectResult {
  table: string;
  pk: { column: string; dbType: string; supported: boolean };
  columns: InspectColumn[];
  systemColumnsPresent: {
    createdAt: boolean;
    updatedAt: boolean;
    ownerId: boolean;
  };
  // Heuristic alias suggestions from the backend — column names that look
  // like a non-conventional version of a system field. Null = no candidate.
  aliasSuggestions: {
    createdAt: string | null;
    updatedAt: string | null;
    ownerId: string | null;
  };
  warnings: string[];
}

// "Modes" for the system-column section in Step 2. The wizard keeps a
// per-field mode rather than the raw flag so we can render a single picker
// that covers (a) no system field, (b) the table already has the
// conventional column, and (c) the user wants to alias an existing column
// to the system field.
type TimeMode = "none" | "conventional" | "alias";
type OwnerMode = "none" | "side-table" | "conventional" | "alias";

interface ColumnDraft {
  name: string;
  dbType: string;
  isPk: boolean;
  reserved: string | null;
  suggested: FieldType | null;
  include: boolean;
  type: FieldType | "";
  required: boolean;
}

export interface AdoptWizardProps {
  open: boolean;
  onClose: () => void;
  onComplete: (collection: { slug: string }) => void;
}

const SLUG_RE = /^[a-z][a-z0-9_]*$/;

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || res.statusText;
    throw new Error(msg);
  }
  return body as T;
}

export function AdoptWizard({ open, onClose, onComplete }: AdoptWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1
  const [tables, setTables] = useState<TableRow[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [tableQuery, setTableQuery] = useState("");

  // Step 2
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnDraft[]>([]);
  // System-column wiring is modeled as a mode picker per logical field. The
  // legacy boolean flags (addCreatedAt / addUpdatedAt / ownerScoped) are
  // derived from the modes when building the apply payload.
  const [createdAtMode, setCreatedAtMode] = useState<TimeMode>("none");
  const [createdAtAlias, setCreatedAtAlias] = useState<string>("");
  const [updatedAtMode, setUpdatedAtMode] = useState<TimeMode>("none");
  const [updatedAtAlias, setUpdatedAtAlias] = useState<string>("");
  const [ownerMode, setOwnerMode] = useState<OwnerMode>("none");
  const [ownerAlias, setOwnerAlias] = useState<string>("");

  // Step 3
  const [slug, setSlug] = useState("");
  const [singular, setSingular] = useState("");
  const [plural, setPlural] = useState("");
  const [note, setNote] = useState("");
  const [defaultSort, setDefaultSort] = useState("");
  const [tenantScoped, setTenantScoped] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Reset state every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setTablesError(null);
    setInspect(null);
    setInspectError(null);
    setColumns([]);
    setCreatedAtMode("none");
    setCreatedAtAlias("");
    setUpdatedAtMode("none");
    setUpdatedAtAlias("");
    setOwnerMode("none");
    setOwnerAlias("");
    setSlug("");
    setSingular("");
    setPlural("");
    setNote("");
    setDefaultSort("");
    setTenantScoped(false);
    setApplying(false);
    setApplyError(null);
    setTableQuery("");

    setTablesLoading(true);
    jsonFetch<{ data: TableRow[] }>("/api/admin/adopt/tables")
      .then((r) => setTables(r.data || []))
      .catch((e) => setTablesError((e as Error).message))
      .finally(() => setTablesLoading(false));
  }, [open]);

  const filteredTables = useMemo(() => {
    const q = tableQuery.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, tableQuery]);

  const selectTable = async (name: string) => {
    setInspectLoading(true);
    setInspectError(null);
    setInspect(null);
    try {
      const r = await jsonFetch<{ data: InspectResult }>(
        "/api/admin/adopt/inspect",
        { method: "POST", body: JSON.stringify({ table: name }) },
      );
      setInspect(r.data);
      // Seed per-column drafts.
      const drafts: ColumnDraft[] = r.data.columns.map((c) => {
        const reserved = c.reserved ?? null;
        const lockedInclude = c.isPk || c.suggested == null || !!reserved;
        const include = c.isPk ? true : c.suggested != null && !reserved;
        return {
          name: c.name,
          dbType: c.dbType,
          isPk: c.isPk,
          reserved,
          suggested: c.suggested,
          include,
          type: (c.suggested ?? "") as FieldType | "",
          required: !c.nullable,
          // include is locked when:
          //  - PK (must include)
          //  - suggested null (unsupported, can't include)
          //  - column name collides with a reserved system column
          _lockedInclude: lockedInclude,
        } as ColumnDraft;
      });
      setColumns(drafts);
      // Seed system-column modes from inspect output. Priority for createdAt
      // and updatedAt: alias suggestion wins (so the heuristic match is the
      // default), else conventional column if present, else "none". Owner
      // defaults to "none" — owner-scoping is opt-in and the alias for
      // owner is a heavier decision than a timestamp alias.
      const sys = r.data.systemColumnsPresent;
      const aliases = r.data.aliasSuggestions;
      if (aliases.createdAt) {
        setCreatedAtMode("alias");
        setCreatedAtAlias(aliases.createdAt);
      } else if (sys.createdAt) {
        setCreatedAtMode("conventional");
        setCreatedAtAlias("");
      } else {
        setCreatedAtMode("none");
        setCreatedAtAlias("");
      }
      if (aliases.updatedAt) {
        setUpdatedAtMode("alias");
        setUpdatedAtAlias(aliases.updatedAt);
      } else if (sys.updatedAt) {
        setUpdatedAtMode("conventional");
        setUpdatedAtAlias("");
      } else {
        setUpdatedAtMode("none");
        setUpdatedAtAlias("");
      }
      setOwnerMode("none");
      setOwnerAlias(aliases.ownerId || "");
      // Seed metadata defaults from the table name.
      setSlug(name);
      setSingular("");
      setPlural("");
      setStep(2);
    } catch (e) {
      setInspectError((e as Error).message);
    } finally {
      setInspectLoading(false);
    }
  };

  const slugClean = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  const slugValid = SLUG_RE.test(slugClean);
  const slugError = !slugClean
    ? "slug is required"
    : !slugValid
      ? "must start with a letter; snake_case only"
      : null;

  const includedFields = columns.filter((c) => c.include && c.type);

  // Derived flags. The apply payload still uses the boolean addCreatedAt /
  // addUpdatedAt for "table already has this column", and ownerScoped
  // covers both side-table and column-aliased ownership.
  const addCreatedAt = createdAtMode === "conventional";
  const addUpdatedAt = updatedAtMode === "conventional";
  const ownerScoped = ownerMode !== "none";
  const createdAtAliasCol = createdAtMode === "alias" ? createdAtAlias : "";
  const updatedAtAliasCol = updatedAtMode === "alias" ? updatedAtAlias : "";
  const ownerAliasCol = ownerMode === "alias" ? ownerAlias : "";

  // If an alias mode is picked, that column must not also be brought in as
  // a regular field — otherwise the backend would treat the same column as
  // both a system slot AND a user-defined column. Flag it for the user.
  const aliasConflicts = useMemo(() => {
    const out: { logical: string; column: string }[] = [];
    const includedNames = new Set(includedFields.map((c) => c.name));
    if (createdAtAliasCol && includedNames.has(createdAtAliasCol)) {
      out.push({ logical: "created_at", column: createdAtAliasCol });
    }
    if (updatedAtAliasCol && includedNames.has(updatedAtAliasCol)) {
      out.push({ logical: "updated_at", column: updatedAtAliasCol });
    }
    if (ownerAliasCol && includedNames.has(ownerAliasCol)) {
      out.push({ logical: "owner_id", column: ownerAliasCol });
    }
    return out;
  }, [createdAtAliasCol, updatedAtAliasCol, ownerAliasCol, includedFields]);

  // An "alias" mode with no column picked is also blocked — the wizard
  // can't ask the backend to alias to nothing.
  const aliasMissingColumn =
    (createdAtMode === "alias" && !createdAtAlias) ||
    (updatedAtMode === "alias" && !updatedAtAlias) ||
    (ownerMode === "alias" && !ownerAlias);

  const canApply =
    !!inspect &&
    slugValid &&
    !applying &&
    includedFields.length > 0 &&
    inspect.pk.supported &&
    aliasConflicts.length === 0 &&
    !aliasMissingColumn;

  const apply = async () => {
    if (!inspect || !canApply) return;
    setApplying(true);
    setApplyError(null);
    try {
      const body = {
        table: inspect.table,
        slug: slugClean,
        singular: singular.trim() || null,
        plural: plural.trim() || null,
        note: note.trim() || null,
        pkColumn: inspect.pk.column,
        ownerScoped,
        tenantScoped,
        defaultSort: defaultSort.trim() || null,
        addCreatedAt: addCreatedAt && !inspect.systemColumnsPresent.createdAt,
        addUpdatedAt: addUpdatedAt && !inspect.systemColumnsPresent.updatedAt,
        // Alias columns. Send the column name when mode === "alias", null
        // otherwise — backend treats null as "use conventional name" (or
        // "no system column at all", depending on the addCreatedAt flag).
        createdAtColumn: createdAtAliasCol || null,
        updatedAtColumn: updatedAtAliasCol || null,
        ownerIdColumn: ownerAliasCol || null,
        fields: includedFields.map((c) => ({
          name: c.name,
          type: c.type as FieldType,
          required: c.required,
        })),
      };
      const r = await jsonFetch<{ data: { slug: string } }>(
        "/api/admin/adopt/apply",
        { method: "POST", body: JSON.stringify(body) },
      );
      onComplete(r.data);
      onClose();
    } catch (e) {
      setApplyError((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog dialog-lg"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 900, width: "94vw", display: "flex", flexDirection: "column", maxHeight: "92vh" }}
      >
        <div className="dialog-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>
              Adopt existing table
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Register a physical table as a workeros collection. No DDL is run on the table — only the collection metadata row + field registrations are written.
            </div>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>

        <div className="addfield-stepper">
          <div className={`step ${step >= 1 ? "on" : ""}`}><span className="num">1</span> Table</div>
          <div className="step-line" />
          <div className={`step ${step >= 2 ? "on" : ""}`}><span className="num">2</span> Fields</div>
          <div className="step-line" />
          <div className={`step ${step >= 3 ? "on" : ""}`}><span className="num">3</span> Metadata</div>
        </div>

        {step === 1 && (
          <Step1Tables
            tables={filteredTables}
            loading={tablesLoading}
            error={tablesError}
            query={tableQuery}
            setQuery={setTableQuery}
            onSelect={selectTable}
            inspectLoading={inspectLoading}
            inspectError={inspectError}
          />
        )}

        {step === 2 && inspect && (
          <Step2Fields
            inspect={inspect}
            columns={columns}
            setColumns={setColumns}
            createdAtMode={createdAtMode}
            setCreatedAtMode={setCreatedAtMode}
            createdAtAlias={createdAtAlias}
            setCreatedAtAlias={setCreatedAtAlias}
            updatedAtMode={updatedAtMode}
            setUpdatedAtMode={setUpdatedAtMode}
            updatedAtAlias={updatedAtAlias}
            setUpdatedAtAlias={setUpdatedAtAlias}
            ownerMode={ownerMode}
            setOwnerMode={setOwnerMode}
            ownerAlias={ownerAlias}
            setOwnerAlias={setOwnerAlias}
            aliasConflicts={aliasConflicts}
          />
        )}

        {step === 3 && inspect && (
          <Step3Metadata
            inspect={inspect}
            slug={slug}
            setSlug={setSlug}
            slugError={slugError}
            singular={singular}
            setSingular={setSingular}
            plural={plural}
            setPlural={setPlural}
            note={note}
            setNote={setNote}
            defaultSort={defaultSort}
            setDefaultSort={setDefaultSort}
            tenantScoped={tenantScoped}
            setTenantScoped={setTenantScoped}
            ownerScoped={ownerScoped}
            ownerMode={ownerMode}
            createdAtMode={createdAtMode}
            createdAtAliasCol={createdAtAliasCol}
            updatedAtMode={updatedAtMode}
            updatedAtAliasCol={updatedAtAliasCol}
            ownerAliasCol={ownerAliasCol}
            fieldsCount={includedFields.length}
            applyError={applyError}
          />
        )}

        <div className="dialog-foot">
          <span className="muted" style={{ fontSize: 12 }}>
            {step === 1 && (
              <>Pick a table to inspect · {tables.length} available</>
            )}
            {step === 2 && inspect && (
              <>
                {includedFields.length} of {columns.length} columns mapped
                {!inspect.pk.supported && (
                  <span style={{ color: "var(--destructive)" }}> · primary key {inspect.pk.dbType} is unsupported</span>
                )}
                {aliasConflicts.length > 0 && (
                  <span style={{ color: "var(--destructive)" }}>
                    {" · "}alias conflict on {aliasConflicts.map((c) => c.column).join(", ")}
                  </span>
                )}
                {aliasMissingColumn && (
                  <span style={{ color: "var(--destructive)" }}>
                    {" · "}pick a column for the aliased system field
                  </span>
                )}
              </>
            )}
            {step === 3 && (
              <>
                {slugError ? (
                  <span style={{ color: "var(--destructive)" }}>{slugError}</span>
                ) : (
                  <>Ready to register <span className="font-mono">{slugClean}</span></>
                )}
              </>
            )}
          </span>
          <div className="spacer" />
          {step > 1 && (
            <Button
              variant="ghost"
              size="sm"
              icon={I.ChevronLeft}
              disabled={applying}
              onClick={() => setStep((s) => (s === 3 ? 2 : 1) as 1 | 2 | 3)}
            >
              Back
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={applying} onClick={onClose}>Cancel</Button>
          {step === 2 && (
            <Button
              variant="primary"
              size="sm"
              iconRight={I.ChevronRight}
              disabled={
                !inspect ||
                !inspect.pk.supported ||
                includedFields.length === 0 ||
                aliasConflicts.length > 0 ||
                aliasMissingColumn
              }
              onClick={() => setStep(3)}
            >
              Next
            </Button>
          )}
          {step === 3 && (
            <Button
              variant="primary"
              size="sm"
              icon={I.Check}
              disabled={!canApply}
              onClick={apply}
            >
              {applying ? "Applying…" : "Apply"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Step 1 ---------------------------------------------------------------

function Step1Tables({
  tables,
  loading,
  error,
  query,
  setQuery,
  onSelect,
  inspectLoading,
  inspectError,
}: {
  tables: TableRow[];
  loading: boolean;
  error: string | null;
  query: string;
  setQuery: (v: string) => void;
  onSelect: (name: string) => void;
  inspectLoading: boolean;
  inspectError: string | null;
}) {
  return (
    <div className="addfield-body">
      <div className="field" style={{ marginBottom: 14 }}>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter tables by name…"
        />
      </div>

      {inspectError && (
        <div
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            border: "1px solid var(--destructive)",
            borderRadius: "var(--radius-md)",
            color: "var(--destructive)",
            fontSize: 12.5,
          }}
        >
          Inspect failed: {inspectError}
        </div>
      )}

      {error && (
        <div className="muted" style={{ fontSize: 12.5, padding: "16px 4px", color: "var(--destructive)" }}>
          Failed to load tables: {error}
        </div>
      )}

      {loading && (
        <div className="muted" style={{ fontSize: 12.5, padding: "16px 4px" }}>Loading tables…</div>
      )}

      {!loading && !error && tables.length === 0 && (
        <div className="muted" style={{ fontSize: 12.5, padding: "16px 4px" }}>
          No tables found that can be adopted.
        </div>
      )}

      {!loading && tables.length > 0 && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            overflow: "hidden",
          }}
        >
          {tables.map((t, idx) => {
            const disabled = !!t.disabled;
            return (
              <div
                key={t.name}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 90px 110px 92px",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 12px",
                  borderTop: idx === 0 ? "none" : "1px solid var(--border)",
                  background: disabled ? "color-mix(in oklch, var(--muted) 60%, var(--card))" : "var(--card)",
                  opacity: disabled ? 0.78 : 1,
                }}
                title={disabled ? `Disabled: ${t.disabled}` : undefined}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <I.Database size={13} />
                  <span className="font-mono" style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {t.name}
                  </span>
                  {disabled && (
                    <Badge variant="outline" mono>
                      {t.disabled}
                    </Badge>
                  )}
                </div>
                <span className="muted tabular-nums" style={{ fontSize: 12 }}>
                  {t.columns} cols
                </span>
                <span className="muted tabular-nums font-mono" style={{ fontSize: 12 }}>
                  ~{t.rowCount} rows
                </span>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <Button
                    variant="primary"
                    size="xs"
                    disabled={disabled || inspectLoading}
                    onClick={() => onSelect(t.name)}
                  >
                    {inspectLoading ? "…" : "Select"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Step 2 ---------------------------------------------------------------

function Step2Fields({
  inspect,
  columns,
  setColumns,
  createdAtMode,
  setCreatedAtMode,
  createdAtAlias,
  setCreatedAtAlias,
  updatedAtMode,
  setUpdatedAtMode,
  updatedAtAlias,
  setUpdatedAtAlias,
  ownerMode,
  setOwnerMode,
  ownerAlias,
  setOwnerAlias,
  aliasConflicts,
}: {
  inspect: InspectResult;
  columns: ColumnDraft[];
  setColumns: (next: ColumnDraft[] | ((prev: ColumnDraft[]) => ColumnDraft[])) => void;
  createdAtMode: TimeMode;
  setCreatedAtMode: (v: TimeMode) => void;
  createdAtAlias: string;
  setCreatedAtAlias: (v: string) => void;
  updatedAtMode: TimeMode;
  setUpdatedAtMode: (v: TimeMode) => void;
  updatedAtAlias: string;
  setUpdatedAtAlias: (v: string) => void;
  ownerMode: OwnerMode;
  setOwnerMode: (v: OwnerMode) => void;
  ownerAlias: string;
  setOwnerAlias: (v: string) => void;
  aliasConflicts: { logical: string; column: string }[];
}) {
  const patch = (i: number, p: Partial<ColumnDraft>) =>
    setColumns((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...p } : c)));

  // Build dropdown options from the inspect columns. Timestamp/integer
  // columns can back created_at / updated_at; text/longtext/uuid can back
  // owner_id. We label with the column name in mono + the workeros type
  // in muted (the dbType is redundant once you see the suggested type).
  const timestampLikeColumns = inspect.columns
    .filter((c) => c.suggested === "timestamp" || c.suggested === "integer")
    .map((c) => ({
      value: c.name,
      label: c.name,
      hint: c.suggested ?? c.dbType,
    }));
  const ownerLikeColumns = inspect.columns
    .filter(
      (c) => c.suggested === "text" || c.suggested === "longtext" || c.suggested === "uuid",
    )
    .map((c) => ({
      value: c.name,
      label: c.name,
      hint: c.suggested ?? c.dbType,
    }));

  return (
    <div className="addfield-body">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <I.Database size={13} />
        <span className="font-mono" style={{ fontSize: 13, fontWeight: 500 }}>{inspect.table}</span>
        <Badge variant="outline" mono>pk: {inspect.pk.column}</Badge>
        {!inspect.pk.supported && (
          <Badge variant="destructive" mono>
            unsupported pk type: {inspect.pk.dbType}
          </Badge>
        )}
      </div>

      {inspect.warnings.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            border: "1px solid color-mix(in oklch, var(--destructive) 40%, var(--border))",
            borderRadius: "var(--radius-md)",
            fontSize: 12,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {inspect.warnings.map((w, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <I.AlertTriangle size={12} />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1.4fr 1fr 90px 1.2fr 100px",
            gap: 12,
            padding: "8px 12px",
            background: "var(--muted)",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--muted-foreground)",
            fontWeight: 600,
          }}
        >
          <span>Column</span>
          <span>DB type</span>
          <span>Include</span>
          <span>Field type</span>
          <span style={{ textAlign: "right" }}>Required</span>
        </div>
        {columns.map((c, i) => {
          const reserved = c.reserved;
          const unsupported = c.suggested == null;
          const lockInclude = (c as any)._lockedInclude as boolean;
          const rowStyle = reserved
            ? {
                borderTop: "1px solid var(--border)",
                background:
                  "color-mix(in oklch, var(--destructive) 7%, var(--card))",
                boxShadow:
                  "inset 0 0 0 1px color-mix(in oklch, var(--destructive) 35%, transparent)",
              }
            : { borderTop: "1px solid var(--border)" };
          return (
            <div
              key={c.name}
              style={{
                display: "grid",
                gridTemplateColumns: "1.4fr 1fr 90px 1.2fr 100px",
                gap: 12,
                padding: "8px 12px",
                alignItems: "center",
                ...rowStyle,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span className="font-mono" style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.name}
                </span>
                {c.isPk && <Badge variant="outline" mono>pk</Badge>}
                {reserved && (
                  <Badge variant="destructive" mono>reserved: {reserved}</Badge>
                )}
                {unsupported && !reserved && (
                  <Badge variant="outline" mono>unsupported</Badge>
                )}
              </div>
              <span className="font-mono muted" style={{ fontSize: 12 }}>{c.dbType}</span>
              <Switch
                checked={c.include}
                disabled={lockInclude}
                onChange={(v) => patch(i, { include: v })}
              />
              <Select
                value={c.type || undefined}
                onChange={(v) => patch(i, { type: v as FieldType })}
                options={FIELD_TYPE_OPTIONS}
                placeholder={unsupported ? "unsupported" : "Pick type…"}
                disabled={unsupported || !c.include}
                size="sm"
              />
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Switch
                  checked={c.required}
                  disabled={!c.include || c.isPk}
                  onChange={(v) => patch(i, { required: v })}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div
        className="card"
        style={{ marginTop: 16, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)" }}
      >
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Settings size={13} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>System columns (optional)</span>
          <span className="font-mono muted" style={{ fontSize: 12 }}>
            flags + aliases — no DDL is run on the table
          </span>
        </div>
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
          <TimeFieldRow
            label="created_at"
            hint="Used for default sort, audit, and the created_at projection."
            conventionalPresent={inspect.systemColumnsPresent.createdAt}
            suggestedAlias={inspect.aliasSuggestions.createdAt}
            mode={createdAtMode}
            setMode={setCreatedAtMode}
            alias={createdAtAlias}
            setAlias={setCreatedAtAlias}
            options={timestampLikeColumns}
          />
          <TimeFieldRow
            label="updated_at"
            hint="Used by revision tracking and the updated_at projection."
            conventionalPresent={inspect.systemColumnsPresent.updatedAt}
            suggestedAlias={inspect.aliasSuggestions.updatedAt}
            mode={updatedAtMode}
            setMode={setUpdatedAtMode}
            alias={updatedAtAlias}
            setAlias={setUpdatedAtAlias}
            options={timestampLikeColumns}
          />
          <OwnerFieldRow
            conventionalPresent={inspect.systemColumnsPresent.ownerId}
            suggestedAlias={inspect.aliasSuggestions.ownerId}
            mode={ownerMode}
            setMode={setOwnerMode}
            alias={ownerAlias}
            setAlias={setOwnerAlias}
            options={ownerLikeColumns}
          />
          {aliasConflicts.length > 0 && (
            <div
              style={{
                marginTop: 4,
                padding: "8px 12px",
                border: "1px solid var(--destructive)",
                borderRadius: "var(--radius-md)",
                color: "var(--destructive)",
                fontSize: 12.5,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {aliasConflicts.map((c) => (
                <div key={c.logical} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <I.AlertTriangle size={12} />
                  <span>
                    Column <span className="font-mono">{c.column}</span> is aliased to {" "}
                    <span className="font-mono">{c.logical}</span> AND included as a regular field. Pick one.
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Segmented mode picker for the system-column rows. Renders as a row of
// shadcn Buttons (the admin wrapper from ./ui) — the active mode is the
// "primary" variant, inactive ones are "ghost". No native radio inputs.
function ModeSegment<M extends string>({
  value,
  options,
}: {
  value: M;
  options: { value: M; label: string; disabled?: boolean; onSelect: () => void }[];
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 6,
        flexWrap: "wrap",
      }}
    >
      {options.map((o) => (
        <Button
          key={o.value}
          variant={value === o.value ? "primary" : "ghost"}
          size="xs"
          disabled={o.disabled}
          onClick={o.onSelect}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

function TimeFieldRow({
  label,
  hint,
  conventionalPresent,
  suggestedAlias,
  mode,
  setMode,
  alias,
  setAlias,
  options,
}: {
  label: string;
  hint: string;
  conventionalPresent: boolean;
  suggestedAlias: string | null;
  mode: TimeMode;
  setMode: (v: TimeMode) => void;
  alias: string;
  setAlias: (v: string) => void;
  options: { value: string; label: string; hint?: string }[];
}) {
  const aliasAvailable = options.length > 0;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        paddingBottom: 12,
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="field-label font-mono" style={{ margin: 0 }}>{label}</span>
        {conventionalPresent && (
          <Badge variant="outline" mono>conventional column present</Badge>
        )}
        {suggestedAlias && !conventionalPresent && (
          <Badge variant="outline" mono>suggested: {suggestedAlias}</Badge>
        )}
      </div>
      <div className="field-hint" style={{ marginTop: -2 }}>{hint}</div>
      <ModeSegment<TimeMode>
        value={mode}
        options={[
          { value: "none", label: "Not used", onSelect: () => setMode("none") },
          {
            value: "conventional",
            label: `Use "${label}" column`,
            disabled: !conventionalPresent,
            onSelect: () => setMode("conventional"),
          },
          {
            value: "alias",
            label: "Alias from another column",
            disabled: !aliasAvailable,
            onSelect: () => {
              setMode("alias");
              if (!alias && suggestedAlias) setAlias(suggestedAlias);
            },
          },
        ]}
      />
      {mode === "alias" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>Column:</span>
          <div style={{ minWidth: 240 }}>
            <Select
              value={alias || undefined}
              onChange={(v) => setAlias(v)}
              options={options}
              placeholder="Pick column…"
              size="sm"
            />
          </div>
          {alias && (
            <span className="muted font-mono" style={{ fontSize: 11 }}>
              {label} ← {alias}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function OwnerFieldRow({
  conventionalPresent,
  suggestedAlias,
  mode,
  setMode,
  alias,
  setAlias,
  options,
}: {
  conventionalPresent: boolean;
  suggestedAlias: string | null;
  mode: OwnerMode;
  setMode: (v: OwnerMode) => void;
  alias: string;
  setAlias: (v: string) => void;
  options: { value: string; label: string; hint?: string }[];
}) {
  const aliasAvailable = options.length > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="field-label font-mono" style={{ margin: 0 }}>owner_id</span>
        {conventionalPresent && (
          <Badge variant="outline" mono>conventional column present</Badge>
        )}
        {suggestedAlias && !conventionalPresent && (
          <Badge variant="outline" mono>suggested: {suggestedAlias}</Badge>
        )}
      </div>
      <div className="field-hint" style={{ marginTop: -2 }}>
        Restricts the authenticated role to its own rows. Pick where ownership lives — a side table, the conventional <span className="font-mono">owner_id</span> column, or an aliased column.
      </div>
      <ModeSegment<OwnerMode>
        value={mode}
        options={[
          { value: "none", label: "Not owner-scoped", onSelect: () => setMode("none") },
          {
            value: "side-table",
            label: "Side-table (item_ownership)",
            onSelect: () => setMode("side-table"),
          },
          {
            value: "conventional",
            label: 'Use "owner_id" column',
            disabled: !conventionalPresent,
            onSelect: () => setMode("conventional"),
          },
          {
            value: "alias",
            label: "Alias from another column",
            disabled: !aliasAvailable,
            onSelect: () => {
              setMode("alias");
              if (!alias && suggestedAlias) setAlias(suggestedAlias);
            },
          },
        ]}
      />
      {mode === "alias" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>Column:</span>
          <div style={{ minWidth: 240 }}>
            <Select
              value={alias || undefined}
              onChange={(v) => setAlias(v)}
              options={options}
              placeholder="Pick column…"
              size="sm"
            />
          </div>
          {alias && (
            <span className="muted font-mono" style={{ fontSize: 11 }}>
              owner_id ← {alias}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Step 3 ---------------------------------------------------------------

function Step3Metadata({
  inspect,
  slug,
  setSlug,
  slugError,
  singular,
  setSingular,
  plural,
  setPlural,
  note,
  setNote,
  defaultSort,
  setDefaultSort,
  tenantScoped,
  setTenantScoped,
  ownerScoped,
  ownerMode,
  createdAtMode,
  createdAtAliasCol,
  updatedAtMode,
  updatedAtAliasCol,
  ownerAliasCol,
  fieldsCount,
  applyError,
}: {
  inspect: InspectResult;
  slug: string;
  setSlug: (v: string) => void;
  slugError: string | null;
  singular: string;
  setSingular: (v: string) => void;
  plural: string;
  setPlural: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
  defaultSort: string;
  setDefaultSort: (v: string) => void;
  tenantScoped: boolean;
  setTenantScoped: (v: boolean) => void;
  ownerScoped: boolean;
  ownerMode: OwnerMode;
  createdAtMode: TimeMode;
  createdAtAliasCol: string;
  updatedAtMode: TimeMode;
  updatedAtAliasCol: string;
  ownerAliasCol: string;
  fieldsCount: number;
  applyError: string | null;
}) {
  // Build a list of "system column wiring" lines for the dry-run summary.
  // Each entry maps a logical system field to the physical resolution
  // (conventional, alias <- column, side table, or "not used").
  const systemColumnLines: string[] = [];
  if (createdAtMode === "alias" && createdAtAliasCol) {
    systemColumnLines.push(`created_at ← ${createdAtAliasCol} (alias)`);
  } else if (createdAtMode === "conventional") {
    systemColumnLines.push("created_at (conventional column)");
  }
  if (updatedAtMode === "alias" && updatedAtAliasCol) {
    systemColumnLines.push(`updated_at ← ${updatedAtAliasCol} (alias)`);
  } else if (updatedAtMode === "conventional") {
    systemColumnLines.push("updated_at (conventional column)");
  }
  if (ownerMode === "alias" && ownerAliasCol) {
    systemColumnLines.push(`owner_id ← ${ownerAliasCol} (alias)`);
  } else if (ownerMode === "conventional") {
    systemColumnLines.push("owner_id (conventional column)");
  } else if (ownerMode === "side-table") {
    systemColumnLines.push("owner_id (item_ownership side-table)");
  }
  return (
    <div className="addfield-body cols-2">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="field">
          <label className="field-label">Slug</label>
          <Input
            className="font-mono"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder={inspect.table}
          />
          <span
            className="field-hint"
            style={slugError ? { color: "var(--destructive)" } : undefined}
          >
            {slugError ?? (
              <>
                URL identifier. Stored as <span className="font-mono">c_{slug || inspect.table}</span> reference (no physical rename).
              </>
            )}
          </span>
        </div>
        <div className="cols-2" style={{ gap: 12 }}>
          <div className="field">
            <label className="field-label">Singular</label>
            <Input value={singular} onChange={(e) => setSingular(e.target.value)} placeholder="product" />
          </div>
          <div className="field">
            <label className="field-label">Plural</label>
            <Input value={plural} onChange={(e) => setPlural(e.target.value)} placeholder="products" />
          </div>
        </div>
        <div className="field">
          <label className="field-label">Note</label>
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Internal description for teammates."
          />
        </div>
        <div className="field">
          <label className="field-label">Default sort <span className="muted">(optional)</span></label>
          <Input
            className="font-mono"
            value={defaultSort}
            onChange={(e) => setDefaultSort(e.target.value)}
            placeholder="-created_at,id"
          />
          <span className="field-hint">
            Comma-separated; prefix with <span className="font-mono">-</span> for descending. Leave blank to fall back to <span className="font-mono">-created_at</span>.
          </span>
        </div>
        <div className="field">
          <label className="field-label">Primary key</label>
          <Input className="font-mono" value={inspect.pk.column} readOnly disabled />
          <span className="field-hint">
            Detected from the source table. <span className="font-mono">{inspect.pk.dbType}</span>
          </span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="field-row" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 10, marginBottom: 10 }}>
          <div>
            <div className="field-label">Tenant-scoped</div>
            <div className="field-hint">
              Rows carry a <span className="font-mono">tenant_id</span>. Adopted tables usually don't — leave off unless you know the source already partitions by tenant.
            </div>
          </div>
          <Switch checked={tenantScoped} onChange={setTenantScoped} />
        </div>

        <div
          className="card"
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            padding: 14,
            background: "var(--muted)",
          }}
        >
          <div className="field-label" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <I.Eye size={12} /> Dry-run summary
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
            <li>
              Will create collection metadata row referencing physical table <span className="font-mono">{inspect.table}</span>.
            </li>
            <li>No DDL on the table.</li>
            <li>
              <span className="tabular-nums">{fieldsCount}</span> fields registered.
            </li>
            {systemColumnLines.length > 0 && (
              <li>
                System columns:
                <ul style={{ margin: "2px 0 0", paddingLeft: 16 }}>
                  {systemColumnLines.map((line) => (
                    <li key={line} className="font-mono" style={{ fontSize: 12 }}>{line}</li>
                  ))}
                </ul>
              </li>
            )}
            <li>
              Permissions:{" "}
              {ownerScoped
                ? "authenticated role gets owner-scoped seed"
                : "admin-only by default"}.
            </li>
          </ul>
        </div>

        {applyError && (
          <div
            style={{
              padding: "8px 12px",
              border: "1px solid var(--destructive)",
              borderRadius: "var(--radius-md)",
              color: "var(--destructive)",
              fontSize: 12.5,
            }}
          >
            {applyError}
          </div>
        )}
      </div>
    </div>
  );
}
