/**
 * Runtime-agnostic env. The Bun entry builds this from process.env; the
 * Worker entry passes the bindings object Cloudflare provides.
 *
 * Worker binding types come from @cloudflare/workers-types (loaded via
 * tsconfig.json `types`).
 */
export interface Env {
  APP_URL: string;
  AUTH_SECRET: string;
  // Postgres URL (self-host or Hyperdrive). One of DATABASE_URL or D1 is required.
  DATABASE_URL?: string;
  // Cloudflare bindings — present only when running on Workers.
  D1?: D1Database;
  R2?: R2Bucket;
  VECTORIZE?: VectorizeIndex;
  HYPERDRIVE?: Hyperdrive;
  REALTIME?: DurableObjectNamespace;
  // Optional AI provider keys.
  OPENAI_API_KEY?: string;
}
