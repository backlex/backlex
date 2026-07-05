/** Bounded length for keys we synthesize from URLs. Long query strings
 *  shouldn't make their way into storage paths. */
export const MAX_IMPORT_KEY_LENGTH = 256;
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
export const IMPORT_TIMEOUT_MS = 30_000;

/** The permission-DSL collection name file operations are gated on. Lives here
 *  (not in routes/storage.ts) so GraphQL twins can share it without importing
 *  a route module. */
export const FILES_COLLECTION = "system_files";
