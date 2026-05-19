/** Bounded length for keys we synthesize from URLs. Long query strings
 *  shouldn't make their way into storage paths. */
export const MAX_IMPORT_KEY_LENGTH = 256;
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
export const IMPORT_TIMEOUT_MS = 30_000;
