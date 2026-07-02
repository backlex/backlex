/**
 * Migration-plan model + builder.
 *
 * `buildPlan` turns a set of source-table inspections into an editable JSON
 * document: which tables to copy, what each becomes (slug, pk, fields,
 * relations), and in what order (FK parents first). The CLI writes it to
 * disk so a human can prune/rename before `import-db run` executes it —
 * same review-then-apply philosophy as the schema-versions GitOps loop.
 *
 * Everything lossy or skipped lands in `warnings` / `reason`; a plan never
 * silently drops data.
 */
import { mapColumn, mapPkType, SYSTEM_COLUMN_PATTERNS, type PlanFieldType } from "./mapping";
import { topoSort } from "./topo";
import type { SourceInspection, SourceTable } from "./types";

export interface PlanField {
  /** Column on the source table (read key during copy). */
  column: string;
  /** Field name on the target collection (write key). Differs from
   *  `column` when the source name is reserved or not snake_case. */
  name: string;
  type: PlanFieldType;
  required?: boolean;
  /** Relation target collection slug (type === "relation"). */
  to?: string;
  /** Dropdown choices (source enum labels). */
  choices?: string[];
}

export interface PlanTable {
  table: string;
  slug: string;
  /** Copy this table? Editable; the builder sets false + `reason` for
   *  tables it can't key (composite/missing/unsupported PK). */
  include: boolean;
  reason?: string;
  pkColumn: string;
  pkType: "uuid" | "text" | "integer";
  /** Source column whose values are copied into the target's system
   *  `created_at` / `updated_at` (detected by naming pattern + type). */
  createdAtColumn: string | null;
  updatedAtColumn: string | null;
  fields: PlanField[];
  warnings: string[];
  approxRows: number | null;
}

export interface MigrationPlan {
  version: 1;
  source: { kind: "postgres" | "mysql" | "sqlite-file" | "mongodb" | "firestore" | "dynamodb" };
  /** Copy order over the included tables — FK parents first. */
  order: string[];
  tables: PlanTable[];
}

const FIELD_NAME = /^[a-z][a-z0-9_]*$/;
const RESERVED = new Set(["id", "owner_id", "created_at", "updated_at"]);

/** snake_case a source identifier into a valid field/slug name. */
export const sanitizeName = (raw: string): string => {
  let s = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+/, "")
    .replace(/_+$/, "")
    .replace(/__+/g, "_");
  if (!s || !/^[a-z]/.test(s)) s = `t_${s}`;
  return s;
};

const uniqueName = (base: string, taken: Set<string>): string => {
  let name = base;
  let i = 2;
  while (taken.has(name)) name = `${base}_${i++}`;
  taken.add(name);
  return name;
};

const TIMESTAMPish = (type: PlanFieldType): boolean =>
  type === "timestamp" || type === "integer";

export const buildPlan = (
  inspections: SourceInspection[],
  tableMeta: Map<string, SourceTable> = new Map(),
  sourceKind: MigrationPlan["source"]["kind"] = "postgres",
): MigrationPlan => {
  const slugTaken = new Set<string>();
  const slugByTable = new Map<string, string>();
  for (const ins of inspections) {
    slugByTable.set(ins.table, uniqueName(sanitizeName(ins.table), slugTaken));
  }

  // First pass — decide inclusion (PK viability) so the relation pass knows
  // which targets exist.
  const pkInfo = new Map<
    string,
    { column: string; pkType: "uuid" | "text" | "integer" } | { reason: string }
  >();
  for (const ins of inspections) {
    if (!ins.pk) {
      // Connectors return a null pk for both "no PK" and "composite PK"
      // (pg-source can't distinguish; Dynamo's HASH+RANGE lands here too) —
      // one honest message covers both.
      pkInfo.set(ins.table, {
        reason:
          "no single-column primary key (missing or composite) — add a surrogate key or copy manually",
      });
      continue;
    }
    const pkType = mapPkType(ins.pk.dbType);
    if (!pkType) {
      pkInfo.set(ins.table, {
        reason: `primary key "${ins.pk.column}" has unsupported type ${ins.pk.dbType}`,
      });
      continue;
    }
    pkInfo.set(ins.table, { column: ins.pk.column, pkType });
  }
  const included = new Set(
    inspections
      .filter((ins) => "column" in (pkInfo.get(ins.table) ?? {}))
      .map((ins) => ins.table),
  );

  const tables: PlanTable[] = inspections.map((ins) => {
    const slug = slugByTable.get(ins.table)!;
    const meta = tableMeta.get(ins.table);
    const pk = pkInfo.get(ins.table)!;
    if (!("column" in pk)) {
      return {
        table: ins.table,
        slug,
        include: false,
        reason: pk.reason,
        pkColumn: ins.pk?.column ?? "id",
        pkType: "text",
        createdAtColumn: null,
        updatedAtColumn: null,
        fields: [],
        warnings: [],
        approxRows: meta?.approxRows ?? null,
      };
    }

    const warnings: string[] = [];
    const byName = new Map(ins.columns.map((c) => [c.name, c] as const));
    const fkByColumn = new Map(
      ins.foreignKeys.filter((fk) => !fk.composite).map((fk) => [fk.column, fk] as const),
    );
    for (const fk of ins.foreignKeys.filter((f) => f.composite)) {
      warnings.push(
        `composite foreign key on "${fk.column}" → ${fk.referencesTable} — backlex relations are single-column; copied as scalar`,
      );
    }

    // System-column detection: the first pattern-named, timestamp-typed
    // column feeds created_at / updated_at and leaves the field list.
    const pickSystem = (patterns: readonly string[]): string | null => {
      for (const name of patterns) {
        const col = byName.get(name);
        if (!col || col.name === pk.column) continue;
        const mapped = mapColumn(col);
        if (mapped && TIMESTAMPish(mapped.type)) return col.name;
      }
      return null;
    };
    const createdAtColumn = pickSystem(SYSTEM_COLUMN_PATTERNS.createdAt);
    const updatedAtColumn = pickSystem(SYSTEM_COLUMN_PATTERNS.updatedAt);

    const fieldTaken = new Set<string>();
    const fields: PlanField[] = [];
    for (const col of ins.columns) {
      if (col.name === pk.column) continue;
      if (col.name === createdAtColumn || col.name === updatedAtColumn) continue;

      const fk = fkByColumn.get(col.name);
      if (fk) {
        if (included.has(fk.referencesTable)) {
          const name = uniqueName(
            RESERVED.has(sanitizeName(col.name))
              ? `${sanitizeName(col.name)}_src`
              : sanitizeName(col.name),
            fieldTaken,
          );
          fields.push({
            column: col.name,
            name,
            type: "relation",
            to: slugByTable.get(fk.referencesTable)!,
            ...(col.nullable ? {} : { required: true }),
          });
          continue;
        }
        warnings.push(
          `foreign key "${col.name}" → ${fk.referencesTable}: target table is not in the plan; copied as scalar`,
        );
      }

      const mapped = mapColumn(col);
      if (!mapped) {
        warnings.push(
          `column "${col.name}" (${col.dbType}) has no copy target — excluded`,
        );
        continue;
      }
      if (mapped.warning) warnings.push(mapped.warning);

      let base = sanitizeName(col.name);
      if (RESERVED.has(base)) {
        base = `${base}_src`;
        warnings.push(
          `column "${col.name}" collides with a reserved system column — copied as field "${base}"`,
        );
      }
      const name = uniqueName(base, fieldTaken);
      fields.push({
        column: col.name,
        name,
        type: mapped.type,
        ...(col.nullable ? {} : { required: true }),
        ...(mapped.choices ? { choices: mapped.choices } : {}),
      });
    }

    return {
      table: ins.table,
      slug,
      include: true,
      pkColumn: pk.column,
      pkType: pk.pkType,
      createdAtColumn,
      updatedAtColumn,
      fields,
      warnings,
      approxRows: meta?.approxRows ?? null,
    };
  });

  // Copy order: FK parents first, over included tables only.
  const edges: [string, string][] = [];
  for (const ins of inspections) {
    if (!included.has(ins.table)) continue;
    for (const fk of ins.foreignKeys) {
      if (fk.composite || fk.referencesTable === ins.table) continue;
      if (included.has(fk.referencesTable)) edges.push([fk.referencesTable, ins.table]);
    }
  }
  const { order, cyclic } = topoSort([...included], edges);
  if (cyclic.length > 0) {
    for (const t of tables) {
      if (cyclic.includes(t.table)) {
        t.warnings.push(
          "part of a foreign-key cycle — copy order is best-effort; the verify step (not per-row checks) validates relation integrity",
        );
      }
    }
  }

  return { version: 1, source: { kind: sourceKind }, order, tables };
};

/** Reshape one source row into the ingest body shape: rename columns to
 *  field names, hoist the PK to `id` and the detected system columns to
 *  `created_at` / `updated_at`. Shared by the CLI pump and the server-side
 *  run executor so both copy paths stay byte-identical. */
export const transformRow = (
  t: PlanTable,
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { id: row[t.pkColumn] };
  if (t.createdAtColumn && row[t.createdAtColumn] !== undefined) {
    out.created_at = row[t.createdAtColumn];
  }
  if (t.updatedAtColumn && row[t.updatedAtColumn] !== undefined) {
    out.updated_at = row[t.updatedAtColumn];
  }
  for (const f of t.fields) {
    const v = row[f.column];
    if (v !== undefined) out[f.name] = v;
  }
  return out;
};

/** Build the `POST /api/collections` payload for a plan table — the one
 *  place the plan's field model maps onto the collections API shape. */
export const collectionPayloadFor = (t: PlanTable) => ({
  slug: t.slug,
  pkType: t.pkType,
  fields: t.fields.map((f) => ({
    name: f.name,
    type: f.type,
    ...(f.required ? { required: true } : {}),
    ...(f.to ? { to: f.to } : {}),
    ...(f.choices
      ? {
          interface: "dropdown",
          options: { choices: f.choices.map((value) => ({ value })) },
        }
      : {}),
  })),
});

/** Can this plan table safely copy into an EXISTING collection with the
 *  same slug? Non-null = human-readable reason it can't. Compatible reuse is
 *  the resume path (the collection was created by an earlier attempt of the
 *  same plan); anything else — an adopted table, a different PK shape, or a
 *  collection missing plan fields — would fail every row confusingly, so
 *  callers reject (or rename) upfront instead. */
export const collectionShapeMismatch = (
  t: PlanTable,
  existing: { pkType?: string | null; adopted?: boolean; fields: { name: string }[] },
): string | null => {
  if (existing.adopted) {
    return `collection "${t.slug}" wraps an adopted table — pick a different slug`;
  }
  if (existing.pkType && existing.pkType !== t.pkType) {
    return `collection "${t.slug}" already exists with pkType "${existing.pkType}" (plan needs "${t.pkType}") — rename the plan slug`;
  }
  const have = new Set(existing.fields.map((f) => f.name));
  const missing = t.fields.filter((f) => !have.has(f.name)).map((f) => f.name);
  if (missing.length > 0) {
    return `collection "${t.slug}" already exists with a different shape (missing: ${missing.join(", ")}) — rename the plan slug`;
  }
  return null;
};

/** Rename plan slugs that collide with existing collections the plan can't
 *  copy into, keeping relation `to` references consistent. `existing` maps
 *  slug → collection shape; compatible collisions are left alone (resume). */
export const dedupeSlugsAgainst = (
  plan: MigrationPlan,
  existing: Map<string, { pkType?: string | null; adopted?: boolean; fields: { name: string }[] }>,
): MigrationPlan => {
  const taken = new Set<string>([
    ...existing.keys(),
    ...plan.tables.map((t) => t.slug),
  ]);
  const renames = new Map<string, string>();
  for (const t of plan.tables) {
    if (!t.include) continue;
    const hit = existing.get(t.slug);
    if (!hit) continue;
    const reason = collectionShapeMismatch(t, hit);
    if (!reason) continue; // compatible — resume into it
    let i = 2;
    let next = `${t.slug}_${i}`;
    while (taken.has(next)) next = `${t.slug}_${++i}`;
    taken.add(next);
    renames.set(t.slug, next);
    t.warnings.push(`${reason.split(" — ")[0]} — importing as "${next}" instead`);
    t.slug = next;
  }
  if (renames.size > 0) {
    for (const t of plan.tables) {
      for (const f of t.fields) {
        if (f.to && renames.has(f.to)) f.to = renames.get(f.to)!;
      }
    }
  }
  return plan;
};

/** Validate a (possibly hand-edited) plan document. Throws with a readable
 *  message on structural problems; returns the typed plan. */
export const parsePlan = (raw: unknown): MigrationPlan => {
  const p = raw as MigrationPlan;
  if (!p || typeof p !== "object") throw new Error("Plan must be a JSON object");
  if (p.version !== 1) throw new Error(`Unsupported plan version: ${String(p.version)}`);
  if (!Array.isArray(p.tables)) throw new Error("Plan is missing `tables`");
  if (!Array.isArray(p.order)) throw new Error("Plan is missing `order`");
  const slugs = new Set<string>();
  for (const t of p.tables) {
    if (!t.table || typeof t.table !== "string") throw new Error("Every table entry needs `table`");
    if (!t.include) continue;
    if (!t.slug || !FIELD_NAME.test(t.slug)) {
      throw new Error(`Table "${t.table}": slug "${t.slug}" must be snake_case starting with a letter`);
    }
    if (slugs.has(t.slug)) throw new Error(`Duplicate slug "${t.slug}" in plan`);
    slugs.add(t.slug);
    if (!t.pkColumn) throw new Error(`Table "${t.table}": pkColumn is required`);
    if (!["uuid", "text", "integer"].includes(t.pkType)) {
      throw new Error(`Table "${t.table}": pkType must be uuid | text | integer`);
    }
    if (!Array.isArray(t.fields)) throw new Error(`Table "${t.table}": fields must be an array`);
    for (const f of t.fields) {
      if (!f.column || !f.name) throw new Error(`Table "${t.table}": every field needs column + name`);
      if (!FIELD_NAME.test(f.name)) {
        throw new Error(`Table "${t.table}": field name "${f.name}" must be snake_case starting with a letter`);
      }
      if (f.type === "relation" && !f.to) {
        throw new Error(`Table "${t.table}": relation field "${f.name}" needs \`to\``);
      }
    }
  }
  const included = new Set(p.tables.filter((t) => t.include).map((t) => t.table));
  for (const name of p.order) {
    if (!included.has(name)) {
      throw new Error(`order references "${name}" which is not an included table`);
    }
  }
  for (const name of included) {
    if (!p.order.includes(name)) {
      throw new Error(`included table "${name}" is missing from order`);
    }
  }
  return p;
};
