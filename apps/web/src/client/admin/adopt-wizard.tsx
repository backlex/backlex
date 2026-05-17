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
  warnings: string[];
}

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
  const [addCreatedAt, setAddCreatedAt] = useState(false);
  const [addUpdatedAt, setAddUpdatedAt] = useState(false);
  const [ownerScoped, setOwnerScoped] = useState(false);

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
    setAddCreatedAt(false);
    setAddUpdatedAt(false);
    setOwnerScoped(false);
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
  const canApply =
    !!inspect &&
    slugValid &&
    !applying &&
    includedFields.length > 0 &&
    inspect.pk.supported;

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
            addCreatedAt={addCreatedAt}
            setAddCreatedAt={setAddCreatedAt}
            addUpdatedAt={addUpdatedAt}
            setAddUpdatedAt={setAddUpdatedAt}
            ownerScoped={ownerScoped}
            setOwnerScoped={setOwnerScoped}
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
                !inspect || !inspect.pk.supported || includedFields.length === 0
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
  addCreatedAt,
  setAddCreatedAt,
  addUpdatedAt,
  setAddUpdatedAt,
  ownerScoped,
  setOwnerScoped,
}: {
  inspect: InspectResult;
  columns: ColumnDraft[];
  setColumns: (next: ColumnDraft[] | ((prev: ColumnDraft[]) => ColumnDraft[])) => void;
  addCreatedAt: boolean;
  setAddCreatedAt: (v: boolean) => void;
  addUpdatedAt: boolean;
  setAddUpdatedAt: (v: boolean) => void;
  ownerScoped: boolean;
  setOwnerScoped: (v: boolean) => void;
}) {
  const patch = (i: number, p: Partial<ColumnDraft>) =>
    setColumns((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...p } : c)));

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
            flags only — no DDL is run on the table
          </span>
        </div>
        <div style={{ padding: "10px 16px" }}>
          <SystemRow
            label="Add created_at column"
            hint="Flag the collection as having a created_at column. workeros will read it for default sort + audit."
            present={inspect.systemColumnsPresent.createdAt}
            checked={addCreatedAt}
            onChange={setAddCreatedAt}
          />
          <SystemRow
            label="Add updated_at column"
            hint="Same flag for updated_at — used by revision tracking."
            present={inspect.systemColumnsPresent.updatedAt}
            checked={addUpdatedAt}
            onChange={setAddUpdatedAt}
          />
          <SystemRow
            label="Owner-scoped (uses item_ownership table)"
            hint="The authenticated role can only read/update its own rows. Ownership rows live in a side table — your physical schema is untouched."
            present={inspect.systemColumnsPresent.ownerId}
            checked={ownerScoped}
            onChange={setOwnerScoped}
            last
          />
        </div>
      </div>
    </div>
  );
}

function SystemRow({
  label,
  hint,
  present,
  checked,
  onChange,
  last,
}: {
  label: string;
  hint: string;
  present: boolean;
  checked: boolean;
  onChange: (v: boolean) => void;
  last?: boolean;
}) {
  return (
    <div
      className="field-row"
      style={
        last
          ? { paddingBottom: 4 }
          : { borderBottom: "1px solid var(--border)", paddingBottom: 10, marginBottom: 10 }
      }
    >
      <div>
        <div className="field-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {label}
          {present && (
            <span className="muted font-mono" style={{ fontSize: 11 }}>Already present</span>
          )}
        </div>
        <div className="field-hint">{hint}</div>
      </div>
      <Switch checked={checked} onChange={onChange} disabled={present} />
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
  fieldsCount: number;
  applyError: string | null;
}) {
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
