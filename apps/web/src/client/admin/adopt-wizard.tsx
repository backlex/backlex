// @ts-nocheck
// Collection adoption wizard — turn an existing physical table into a
// workeros collection. 3 steps:
//   1) pick a table (GET /api/admin/adopt/tables)
//   2) map columns to FieldType (POST /api/admin/adopt/inspect)
//   3) metadata + dry-run summary → POST /api/collections (adopted: true)
//
// No DDL is run on the user's table — adoption only writes the collection
// metadata row + per-field registrations. System-column toggles set flags
// only; the backend decides whether to backfill anything later. The unified
// create endpoint (`POST /api/collections`) handles both managed and adopted
// flows; this wizard's submit just sets `adopted: true` and passes the
// introspected `physicalTable`/`pkColumn`/alias columns.
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { Skeleton } from "@workeros/ui/components/skeleton";
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

interface InspectForeignKey {
  // Source column on the table being inspected.
  column: string;
  // Parent table referenced by this FK.
  referencesTable: string;
  // Parent column. May be empty string if unresolvable.
  referencesColumn: string;
  // True when the FK spans multiple columns. workeros' relation field is
  // single-column, so composite FKs are surfaced but cannot be adopted.
  composite: boolean;
  // Set by the route layer when the parent table already maps to an existing
  // collection in this workspace. Null = the parent hasn't been adopted yet.
  targetCollection: { slug: string; id: string } | null;
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
  // Foreign keys detected on the source table. Composite FKs are listed but
  // disabled in the UI — workeros relations are single-column only.
  foreignKeys: InspectForeignKey[];
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
  const { t } = useLingui();
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
  // Foreign key drafts. One entry per FK from inspect.foreignKeys (composite
  // FKs included for display, but `adopt` stays false). `targetSlug` is the
  // workspace collection the FK should point at — pre-filled when the parent
  // table is already adopted in this workspace.
  const [fkDrafts, setFkDrafts] = useState<
    { column: string; referencesTable: string; composite: boolean; targetSlug: string; adopt: boolean }[]
  >([]);
  // Workspace collections used to populate FK target dropdowns. Lazy-fetched
  // once per dialog open — adoption is admin-only and lists tend to be small.
  const [availableCollections, setAvailableCollections] = useState<
    { slug: string }[]
  >([]);
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
    setFkDrafts([]);
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

    // Pre-fetch the workspace's adopted/managed collections for the FK
    // target dropdown. Failures here are non-fatal — the FK panel will
    // simply show an empty option list.
    jsonFetch<{ data: { slug: string }[] }>("/api/collections")
      .then((r) => setAvailableCollections(r.data || []))
      .catch(() => setAvailableCollections([]));
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
      // Seed FK drafts. Composite FKs are listed but force-disabled
      // (`adopt: false`). Single-column FKs whose parent table is already
      // adopted default to ON; FKs without a target collection default to
      // OFF (the user has to adopt the parent first).
      const fks = (r.data.foreignKeys || []).map((fk) => ({
        column: fk.column,
        referencesTable: fk.referencesTable,
        composite: fk.composite,
        targetSlug: fk.targetCollection?.slug ?? "",
        adopt: !fk.composite && !!fk.targetCollection,
      }));
      setFkDrafts(fks);
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
    ? t`slug is required`
    : !slugValid
      ? t`must start with a letter; snake_case only`
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

  // FK drafts that are toggled "Adopt as relation" AND have a target slug
  // picked. These get their `type` overridden to `relation` in the apply
  // payload (with `to: <slug>`). Composite FKs are filtered out — workeros'
  // relation field is single-column only.
  const activeFkRelations = useMemo(
    () => fkDrafts.filter((fk) => fk.adopt && !fk.composite && fk.targetSlug),
    [fkDrafts],
  );
  const activeFkBySource = useMemo(() => {
    const m = new Map<string, { targetSlug: string; referencesTable: string }>();
    for (const fk of activeFkRelations) {
      m.set(fk.column, { targetSlug: fk.targetSlug, referencesTable: fk.referencesTable });
    }
    return m;
  }, [activeFkRelations]);

  // Conflict: the user toggled an FK to "Adopt as relation" but also
  // manually picked a non-relation type for that same column in the field
  // mapping list. The apply payload sends `relation` (the FK panel wins),
  // but we should still flag it so the user knows the column-row choice
  // will be overridden.
  const fkColumnConflicts = useMemo(() => {
    const out: { column: string; manualType: string }[] = [];
    for (const c of columns) {
      const active = activeFkBySource.get(c.name);
      if (!active) continue;
      if (!c.include) continue;
      // Anything other than a placeholder is a "manual override" — the user
      // explicitly picked a scalar type while the FK row asks for relation.
      if (c.type && c.type !== "uuid" && c.type !== "integer" && c.type !== "text") {
        out.push({ column: c.name, manualType: c.type });
      }
    }
    return out;
  }, [columns, activeFkBySource]);

  // FK toggled ON but no target slug picked — the wizard can't build a
  // relation field without a `to:` value, so block apply.
  const fkMissingTarget = fkDrafts.some(
    (fk) => fk.adopt && !fk.composite && !fk.targetSlug,
  );

  const canApply =
    !!inspect &&
    slugValid &&
    !applying &&
    includedFields.length > 0 &&
    inspect.pk.supported &&
    aliasConflicts.length === 0 &&
    !aliasMissingColumn &&
    fkColumnConflicts.length === 0 &&
    !fkMissingTarget;

  const apply = async () => {
    if (!inspect || !canApply) return;
    setApplying(true);
    setApplyError(null);
    try {
      const body = {
        adopted: true,
        physicalTable: inspect.table,
        slug: slugClean,
        singular: singular.trim() || null,
        plural: plural.trim() || null,
        note: note.trim() || null,
        pkColumn: inspect.pk.column,
        ownerScoped,
        tenantScoped,
        defaultSort: defaultSort.trim() || null,
        // hasCreatedAt/hasUpdatedAt are the user's *assertion* that the
        // source table has the conventional column. The unified server
        // route still cross-checks with introspect; we only send `true`
        // when the toggle is on AND inspect didn't already see the column
        // (when inspect saw it, the server uses that as the source of
        // truth so we don't need to assert anything).
        hasCreatedAt: addCreatedAt && !inspect.systemColumnsPresent.createdAt,
        hasUpdatedAt: addUpdatedAt && !inspect.systemColumnsPresent.updatedAt,
        // Alias columns. Send the column name when mode === "alias", null
        // otherwise — backend treats null as "use conventional name" (or
        // "no system column at all", depending on the hasCreatedAt flag).
        createdAtColumn: createdAtAliasCol || null,
        updatedAtColumn: updatedAtAliasCol || null,
        ownerIdColumn: ownerAliasCol || null,
        // For each included field, if it's also an active FK relation,
        // override the scalar `type` with `relation` and include the target
        // collection slug as `to`. Faz 1's validateRelations checks target
        // row existence on insert, so we don't have to pre-validate here.
        fields: includedFields.map((c) => {
          const active = activeFkBySource.get(c.name);
          if (active) {
            return {
              name: c.name,
              type: "relation" as const,
              required: c.required,
              to: active.targetSlug,
            };
          }
          return {
            name: c.name,
            type: c.type as FieldType,
            required: c.required,
          };
        }),
      };
      const r = await jsonFetch<{ data: { slug: string } }>(
        "/api/collections",
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
              <Trans>Adopt existing table</Trans>
            </div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              <Trans>Register a physical table as a workeros collection. No DDL is run on the table — only the collection metadata row + field registrations are written.</Trans>
            </div>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>

        <div className="addfield-stepper">
          <div className={`step ${step >= 1 ? "on" : ""}`}><span className="num">1</span> <Trans>Table</Trans></div>
          <div className="step-line" />
          <div className={`step ${step >= 2 ? "on" : ""}`}><span className="num">2</span> <Trans>Fields</Trans></div>
          <div className="step-line" />
          <div className={`step ${step >= 3 ? "on" : ""}`}><span className="num">3</span> <Trans>Metadata</Trans></div>
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
            fkDrafts={fkDrafts}
            setFkDrafts={setFkDrafts}
            availableCollections={availableCollections}
            fkColumnConflicts={fkColumnConflicts}
            fkMissingTarget={fkMissingTarget}
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
            activeFkRelations={activeFkRelations}
            applyError={applyError}
          />
        )}

        <div className="dialog-foot">
          <span className="muted" style={{ fontSize: 12 }}>
            {step === 1 && (
              <Trans>Pick a table to inspect · {tables.length} available</Trans>
            )}
            {step === 2 && inspect && (
              <>
                <Trans>{includedFields.length} of {columns.length} columns mapped</Trans>
                {!inspect.pk.supported && (
                  <span style={{ color: "var(--destructive)" }}> · <Trans>primary key {inspect.pk.dbType} is unsupported</Trans></span>
                )}
                {aliasConflicts.length > 0 && (
                  <span style={{ color: "var(--destructive)" }}>
                    {" · "}
                    <Trans>alias conflict on {aliasConflicts.map((c) => c.column).join(", ")}</Trans>
                  </span>
                )}
                {aliasMissingColumn && (
                  <span style={{ color: "var(--destructive)" }}>
                    {" · "}<Trans>pick a column for the aliased system field</Trans>
                  </span>
                )}
                {fkColumnConflicts.length > 0 && (
                  <span style={{ color: "var(--destructive)" }}>
                    {" · "}<Trans>FK conflict on {fkColumnConflicts.map((c) => c.column).join(", ")}</Trans>
                  </span>
                )}
                {fkMissingTarget && (
                  <span style={{ color: "var(--destructive)" }}>
                    {" · "}<Trans>pick a target collection for the adopted FK</Trans>
                  </span>
                )}
              </>
            )}
            {step === 3 && (
              <>
                {slugError ? (
                  <span style={{ color: "var(--destructive)" }}>{slugError}</span>
                ) : (
                  <Trans>Ready to register <span className="font-mono">{slugClean}</span></Trans>
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
              <Trans>Back</Trans>
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={applying} onClick={onClose}><Trans>Cancel</Trans></Button>
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
                aliasMissingColumn ||
                fkColumnConflicts.length > 0 ||
                fkMissingTarget
              }
              onClick={() => setStep(3)}
            >
              <Trans>Next</Trans>
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
              {applying ? <Trans>Applying…</Trans> : <Trans>Apply</Trans>}
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
  const { t } = useLingui();
  return (
    <div className="addfield-body">
      <div className="field" style={{ marginBottom: 14 }}>
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t`Filter tables by name…`}
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
          <Trans>Inspect failed: {inspectError}</Trans>
        </div>
      )}

      {error && (
        <div className="muted" style={{ fontSize: 12.5, padding: "16px 4px", color: "var(--destructive)" }}>
          <Trans>Failed to load tables: {error}</Trans>
        </div>
      )}

      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 4px" }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      )}

      {!loading && !error && tables.length === 0 && (
        <div className="muted" style={{ fontSize: 12.5, padding: "16px 4px" }}>
          <Trans>No tables found that can be adopted.</Trans>
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
                  <Trans>{t.columns} cols</Trans>
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
                    {inspectLoading ? "…" : <Trans>Select</Trans>}
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
  fkDrafts,
  setFkDrafts,
  availableCollections,
  fkColumnConflicts,
  fkMissingTarget,
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
  fkDrafts: {
    column: string;
    referencesTable: string;
    composite: boolean;
    targetSlug: string;
    adopt: boolean;
  }[];
  setFkDrafts: (
    next:
      | typeof fkDrafts
      | ((prev: typeof fkDrafts) => typeof fkDrafts),
  ) => void;
  availableCollections: { slug: string }[];
  fkColumnConflicts: { column: string; manualType: string }[];
  fkMissingTarget: boolean;
}) {
  const { t } = useLingui();
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
            <Trans>unsupported pk type: {inspect.pk.dbType}</Trans>
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
          <span><Trans>Column</Trans></span>
          <span><Trans>DB type</Trans></span>
          <span><Trans>Include</Trans></span>
          <span><Trans>Field type</Trans></span>
          <span style={{ textAlign: "right" }}><Trans>Required</Trans></span>
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
                  <Badge variant="outline" mono><Trans>unsupported</Trans></Badge>
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
                placeholder={unsupported ? t`unsupported` : t`Pick type…`}
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

      {fkDrafts.length > 0 && (
        <ForeignKeysPanel
          fkDrafts={fkDrafts}
          setFkDrafts={setFkDrafts}
          availableCollections={availableCollections}
          fkColumnConflicts={fkColumnConflicts}
          fkMissingTarget={fkMissingTarget}
        />
      )}

      <div
        className="card"
        style={{ marginTop: 16, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)" }}
      >
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Settings size={13} />
          <span style={{ fontSize: 13, fontWeight: 500 }}><Trans>System columns (optional)</Trans></span>
          <span className="font-mono muted" style={{ fontSize: 12 }}>
            <Trans>flags + aliases — no DDL is run on the table</Trans>
          </span>
        </div>
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
          <TimeFieldRow
            label="created_at"
            hint={t`Used for default sort, audit, and the created_at projection.`}
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
            hint={t`Used by revision tracking and the updated_at projection.`}
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
                    <Trans>Column <span className="font-mono">{c.column}</span> is aliased to {" "}
                    <span className="font-mono">{c.logical}</span> AND included as a regular field. Pick one.</Trans>
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

// "Foreign keys detected" panel — shown in Step 2 between the field
// mapping table and the system-columns card. Each FK row offers a target
// dropdown (workspace collections) + an "Adopt as relation" toggle.
// Composite FKs are listed but disabled with a "not supported" badge.
// When the toggle is ON, the source column's type is overridden to
// `relation` in the apply payload (with `to: <slug>`).
function ForeignKeysPanel({
  fkDrafts,
  setFkDrafts,
  availableCollections,
  fkColumnConflicts,
  fkMissingTarget,
}: {
  fkDrafts: {
    column: string;
    referencesTable: string;
    composite: boolean;
    targetSlug: string;
    adopt: boolean;
  }[];
  setFkDrafts: (
    next:
      | typeof fkDrafts
      | ((prev: typeof fkDrafts) => typeof fkDrafts),
  ) => void;
  availableCollections: { slug: string }[];
  fkColumnConflicts: { column: string; manualType: string }[];
  fkMissingTarget: boolean;
}) {
  const { t } = useLingui();
  const options = availableCollections.map((c) => ({ value: c.slug, label: c.slug }));
  const patch = (
    i: number,
    p: Partial<(typeof fkDrafts)[number]>,
  ) => setFkDrafts((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...p } : c)));

  return (
    <div
      className="card"
      style={{ marginTop: 16, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)" }}
    >
      <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <I.Link size={13} />
        <span style={{ fontSize: 13, fontWeight: 500 }}><Trans>Foreign keys detected</Trans></span>
        <span className="font-mono muted" style={{ fontSize: 12 }}>
          {fkDrafts.length} {fkDrafts.length === 1 ? <Trans>key</Trans> : <Trans>keys</Trans>} — <Trans>adopt as workeros relations</Trans>
        </span>
      </div>
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
        {fkDrafts.map((fk, i) => {
          const composite = fk.composite;
          const targetMissing = !fk.targetSlug && !composite;
          // Parent table has no matching adopted collection in this workspace.
          // We disable the toggle and point the user at the right next step.
          const noTarget = !fk.targetSlug && !composite;
          return (
            <div
              key={`${fk.column}-${i}`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                paddingBottom: i === fkDrafts.length - 1 ? 0 : 12,
                borderBottom: i === fkDrafts.length - 1 ? "none" : "1px solid var(--border)",
                opacity: composite ? 0.6 : 1,
              }}
              title={composite ? t`Composite (multi-column) FKs cannot be adopted as a workeros relation` : undefined}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span className="font-mono" style={{ fontSize: 13, fontWeight: 500 }}>
                  {fk.column}
                </span>
                <span className="muted" style={{ fontSize: 12 }}>→</span>
                <span className="font-mono" style={{ fontSize: 13 }}>{fk.referencesTable}</span>
                {composite && (
                  <Badge variant="outline" mono><Trans>composite — not supported</Trans></Badge>
                )}
                {!composite && fk.targetSlug && (
                  <Badge variant="outline" mono>target: {fk.targetSlug}</Badge>
                )}
                {!composite && noTarget && (
                  <Badge variant="destructive" mono><Trans>parent not adopted</Trans></Badge>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span className="muted" style={{ fontSize: 12 }}><Trans>Target:</Trans></span>
                <div style={{ minWidth: 220 }}>
                  <Select
                    value={fk.targetSlug || undefined}
                    onChange={(v) => patch(i, { targetSlug: v })}
                    options={options}
                    placeholder={composite ? "—" : t`Pick collection…`}
                    disabled={composite || options.length === 0}
                    size="sm"
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Switch
                    checked={fk.adopt && !composite}
                    disabled={composite || noTarget}
                    onChange={(v) => patch(i, { adopt: v })}
                  />
                  <span className="muted" style={{ fontSize: 12 }}>
                    <Trans>Adopt as relation</Trans>
                  </span>
                </div>
                {noTarget && (
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    <Trans>Adopt <span className="font-mono">{fk.referencesTable}</span> as a workeros
                    collection first, then revisit this step.</Trans>
                  </span>
                )}
                {targetMissing && fk.adopt && (
                  <span style={{ color: "var(--destructive)", fontSize: 11.5 }}>
                    <Trans>Pick a target collection.</Trans>
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {(fkColumnConflicts.length > 0 || fkMissingTarget) && (
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
            {fkColumnConflicts.map((c) => (
              <div key={c.column} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <I.AlertTriangle size={12} />
                <span>
                  <Trans>Column <span className="font-mono">{c.column}</span> is mapped to{" "}
                  <span className="font-mono">{c.manualType}</span> in the field list but also
                  toggled "Adopt as relation". The FK panel will override the field type.</Trans>
                </span>
              </div>
            ))}
            {fkMissingTarget && (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <I.AlertTriangle size={12} />
                <span><Trans>One or more adopted FKs are missing a target collection.</Trans></span>
              </div>
            )}
          </div>
        )}
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
  const { t } = useLingui();
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
          <Badge variant="outline" mono><Trans>conventional column present</Trans></Badge>
        )}
        {suggestedAlias && !conventionalPresent && (
          <Badge variant="outline" mono><Trans>suggested: {suggestedAlias}</Trans></Badge>
        )}
      </div>
      <div className="field-hint" style={{ marginTop: -2 }}>{hint}</div>
      <ModeSegment<TimeMode>
        value={mode}
        options={[
          { value: "none", label: t`Not used`, onSelect: () => setMode("none") },
          {
            value: "conventional",
            label: t`Use "${label}" column`,
            disabled: !conventionalPresent,
            onSelect: () => setMode("conventional"),
          },
          {
            value: "alias",
            label: t`Alias from another column`,
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
          <span className="muted" style={{ fontSize: 12 }}><Trans>Column:</Trans></span>
          <div style={{ minWidth: 240 }}>
            <Select
              value={alias || undefined}
              onChange={(v) => setAlias(v)}
              options={options}
              placeholder={t`Pick column…`}
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
  const { t } = useLingui();
  const aliasAvailable = options.length > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="field-label font-mono" style={{ margin: 0 }}>owner_id</span>
        {conventionalPresent && (
          <Badge variant="outline" mono><Trans>conventional column present</Trans></Badge>
        )}
        {suggestedAlias && !conventionalPresent && (
          <Badge variant="outline" mono><Trans>suggested: {suggestedAlias}</Trans></Badge>
        )}
      </div>
      <div className="field-hint" style={{ marginTop: -2 }}>
        <Trans>Restricts the authenticated role to its own rows. Pick where ownership lives — a side table, the conventional <span className="font-mono">owner_id</span> column, or an aliased column.</Trans>
      </div>
      <ModeSegment<OwnerMode>
        value={mode}
        options={[
          { value: "none", label: t`Not owner-scoped`, onSelect: () => setMode("none") },
          {
            value: "side-table",
            label: t`Side-table (item_ownership)`,
            onSelect: () => setMode("side-table"),
          },
          {
            value: "conventional",
            label: t`Use "owner_id" column`,
            disabled: !conventionalPresent,
            onSelect: () => setMode("conventional"),
          },
          {
            value: "alias",
            label: t`Alias from another column`,
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
          <span className="muted" style={{ fontSize: 12 }}><Trans>Column:</Trans></span>
          <div style={{ minWidth: 240 }}>
            <Select
              value={alias || undefined}
              onChange={(v) => setAlias(v)}
              options={options}
              placeholder={t`Pick column…`}
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
  activeFkRelations,
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
  activeFkRelations: {
    column: string;
    referencesTable: string;
    composite: boolean;
    targetSlug: string;
    adopt: boolean;
  }[];
  applyError: string | null;
}) {
  const { t } = useLingui();
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
          <label className="field-label"><Trans>Slug</Trans></label>
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
              <Trans>
                URL identifier. References the existing <span className="font-mono">{inspect.table}</span> table (no physical rename).
              </Trans>
            )}
          </span>
        </div>
        <div className="cols-2" style={{ gap: 12 }}>
          <div className="field">
            <label className="field-label"><Trans>Singular</Trans></label>
            <Input value={singular} onChange={(e) => setSingular(e.target.value)} placeholder="product" />
          </div>
          <div className="field">
            <label className="field-label"><Trans>Plural</Trans></label>
            <Input value={plural} onChange={(e) => setPlural(e.target.value)} placeholder="products" />
          </div>
        </div>
        <div className="field">
          <label className="field-label"><Trans>Note</Trans></label>
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t`Internal description for teammates.`}
          />
        </div>
        <div className="field">
          <label className="field-label"><Trans>Default sort <span className="muted">(optional)</span></Trans></label>
          <Input
            className="font-mono"
            value={defaultSort}
            onChange={(e) => setDefaultSort(e.target.value)}
            placeholder="-created_at,id"
          />
          <span className="field-hint">
            <Trans>Comma-separated; prefix with <span className="font-mono">-</span> for descending. Leave blank to fall back to <span className="font-mono">-created_at</span>.</Trans>
          </span>
        </div>
        <div className="field">
          <label className="field-label"><Trans>Primary key</Trans></label>
          <Input className="font-mono" value={inspect.pk.column} readOnly disabled />
          <span className="field-hint">
            <Trans>Detected from the source table. <span className="font-mono">{inspect.pk.dbType}</span></Trans>
          </span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="field-row" style={{ borderBottom: "1px solid var(--border)", paddingBottom: 10, marginBottom: 10 }}>
          <div>
            <div className="field-label"><Trans>Tenant-scoped</Trans></div>
            <div className="field-hint">
              <Trans>Rows carry a <span className="font-mono">tenant_id</span>. Adopted tables usually don't — leave off unless you know the source already partitions by tenant.</Trans>
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
            <I.Eye size={12} /> <Trans>Dry-run summary</Trans>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
            <li>
              <Trans>Will create collection metadata row referencing physical table <span className="font-mono">{inspect.table}</span>.</Trans>
            </li>
            <li><Trans>No DDL on the table.</Trans></li>
            <li>
              <Trans><span className="tabular-nums">{fieldsCount}</span> fields registered.</Trans>
            </li>
            {systemColumnLines.length > 0 && (
              <li>
                <Trans>System columns:</Trans>
                <ul style={{ margin: "2px 0 0", paddingLeft: 16 }}>
                  {systemColumnLines.map((line) => (
                    <li key={line} className="font-mono" style={{ fontSize: 12 }}>{line}</li>
                  ))}
                </ul>
              </li>
            )}
            {activeFkRelations.length > 0 && (
              <li>
                <Trans>Foreign keys adopted as relations:</Trans>
                <ul style={{ margin: "2px 0 0", paddingLeft: 16 }}>
                  {activeFkRelations.map((fk) => (
                    <li key={fk.column} className="font-mono" style={{ fontSize: 12 }}>
                      {fk.column} → {fk.targetSlug} (relation)
                    </li>
                  ))}
                </ul>
              </li>
            )}
            <li>
              <Trans>Permissions:{" "}
              {ownerScoped
                ? "authenticated role gets owner-scoped seed"
                : "admin-only by default"}.</Trans>
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
