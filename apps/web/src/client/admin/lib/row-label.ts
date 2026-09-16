// Moved to `@backlex/core/row-label` so the server labels a relation the same
// way the admin does (a KPI grouped by a relation). Re-exported so the admin's
// imports keep their path.
export {
  makeLabelFor,
  needsDisplayTemplate,
  pickRelationLabel,
  rowLabel,
  shortId,
  type LabelFn,
  type LabelSchemaField,
} from "@backlex/core/row-label";
