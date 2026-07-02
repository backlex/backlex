export {
  mapColumn,
  mapPkType,
  SYSTEM_COLUMN_PATTERNS,
  type MappedColumn,
  type PlanFieldType,
} from "./mapping";
export {
  buildPlan,
  collectionPayloadFor,
  collectionShapeMismatch,
  dedupeSlugsAgainst,
  parsePlan,
  sanitizeName,
  transformRow,
  type MigrationPlan,
  type PlanField,
  type PlanTable,
} from "./plan";
export { createPgSource } from "./pg-source";
export { createMysqlSource, parseEnumLabels } from "./mysql-source";
export { createSqliteFileSource } from "./sqlite-source";
export {
  createMongoSource,
  inferColumns,
  looksLikeObjectIdHex,
  MONGO_DEFAULT_SAMPLE,
  type DocumentSource,
} from "./mongo-source";
export { topoSort } from "./topo";
export type {
  ReadBatchOptions,
  SourceColumn,
  SourceConnector,
  SourceForeignKey,
  SourceInspection,
  SourceQuery,
  SourceTable,
} from "./types";
