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
  // Email transport. If RESEND_API_KEY is set, transactional emails go via
  // Resend; otherwise messages are logged to stdout (dev console adapter).
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  // OAuth providers. Each provider is enabled iff both id+secret are set.
  OAUTH_GOOGLE_CLIENT_ID?: string;
  OAUTH_GOOGLE_CLIENT_SECRET?: string;
  OAUTH_GITHUB_CLIENT_ID?: string;
  OAUTH_GITHUB_CLIENT_SECRET?: string;
  /** Comma-separated better-auth plugin names: `magic-link,email-otp,anonymous`. */
  AUTH_PLUGINS?: string;
  /** Comma-separated host allow-list for `ctx.fetch` inside functions.
   *  `*` allows any host (development only). Empty disables outbound fetch. */
  FUNCTIONS_FETCH_ALLOW?: string;
  /** Cloudflare Workers-for-Platforms dispatch namespace. When bound, the
   *  cf-dispatch sandbox provider routes function invocations to the
   *  `workeros-fn-executor` sub-Worker in this namespace (V8 isolate
   *  per request). Optional — falls back to bun-worker / quickjs when
   *  unbound. */
  FUNCTIONS_DISPATCH?: DispatchNamespace;
  /** HTTP base URL of an out-of-isolate function executor (e.g. the
   *  `templates/fn-exec-server` Bun process on Fly / Railway / a VM). When
   *  set, the `remote-http` sandbox provider POSTs invocations to
   *  `${FUNCTIONS_EXEC_URL}/run` — lets the API run on an edge runtime (CF
   *  Workers / Vercel Edge / Netlify Edge) while still offering DB-aware
   *  functions. Pairs with `SANDBOX_RPC_TOKEN` + `SELF_URL` for `ctx.*`. */
  FUNCTIONS_EXEC_URL?: string;
  /** Shared secret authenticating executor → main Worker RPC calls
   *  (`/api/_internal/sandbox-rpc`). Required for cf-dispatch / remote-http
   *  ctx.* host bridges. Generate with `openssl rand -hex 32`. */
  SANDBOX_RPC_TOKEN?: string;
  /** Public origin of the main Worker — used by the executor to call back
   *  for ctx.* RPC. Defaults to the request origin when invoked over HTTP;
   *  cron triggers must set this explicitly (no incoming request to
   *  derive from). */
  SELF_URL?: string;
  /** S3-compatible storage. When `S3_BUCKET` is set the storage adapter
   *  selects S3 (via `Bun.S3Client` when on Bun, else `aws4fetch`).
   *  Compatible with AWS S3, Cloudflare R2, Backblaze B2, MinIO,
   *  DigitalOcean Spaces, Wasabi. Leave `S3_ENDPOINT` blank for AWS. */
  S3_BUCKET?: string;
  S3_REGION?: string;
  S3_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  /** Days of audit-log history to keep. Rows older than this are pruned by
   *  the daily cron tick. Defaults to 90. Set to `0` to disable pruning. */
  ACTIVITY_RETENTION_DAYS?: string;
}
