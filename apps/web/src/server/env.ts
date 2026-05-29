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
  /** Optional read-replica Postgres URL. When set (pg dialect only), `ctx.dbRead`
   *  resolves to a second Drizzle client pointed at this URL; lag-tolerant
   *  read paths can opt into it explicitly. Unset, omitted, or non-pg
   *  dialect → `ctx.dbRead === ctx.db` (silent fallback to primary). Replication
   *  lag means reads-after-write may miss the freshly written row — keep
   *  post-mutation reads on `ctx.db`. On Workers, prefer the
   *  `HYPERDRIVE_REPLICA` binding (set in wrangler.toml) over a raw URL. */
  DATABASE_REPLICA_URL?: string;
  /** Postgres driver. `postgres-js` (default) uses `node:net`/`node:tls` — works
   *  on Bun, Node, Cloudflare Workers (nodejs_compat), and Netlify Edge (Deno
   *  polyfill). `neon-http` uses fetch() and is the only viable driver on
   *  Vercel Edge; it requires a Neon database URL (or a self-hosted wsproxy
   *  in front of any Postgres). Applies to both primary and replica URLs. */
  DATABASE_DRIVER?: "postgres-js" | "neon-http";
  /** Shared secret for the `/api/_cron/tick` endpoint on Vercel/Netlify. The
   *  request must send `x-cron-secret: <CRON_SECRET>`. When unset, the
   *  endpoint refuses every request (the public internet should not be able
   *  to trigger cron). Cloudflare Workers and Bun run cron internally and
   *  don't expose this endpoint. */
  CRON_SECRET?: string;
  /** SQLite file path for Bun self-host. Defaults to `./.data/backlex.sqlite`.
   *  Override for tests (e.g. a temp file per run) or alternate disk layouts.
   *  Point this at `/litefs/backlex.sqlite` (or wherever LiteFS mounts) to
   *  run on top of Fly LiteFS — backlex doesn't need any additional code
   *  to talk to LiteFS; the FUSE layer handles replication transparently. */
  SQLITE_PATH?: string;
  /** libSQL / Turso URL. Selects the libSQL transport client instead of
   *  Bun SQLite / D1 / Postgres. Schemes:
   *    `libsql://…` (Turso, default)  `wss://…` / `ws://…` (Hrana WS)
   *    `https://…` / `http://…` (Hrana HTTP)  `file:…` (local file)
   *  Loses to a D1 binding (CF Workers) but wins over `DATABASE_URL` so an
   *  operator can flip a Postgres deploy to Turso by setting one env var. */
  LIBSQL_URL?: string;
  /** Bearer token for the libSQL endpoint. Required for any Turso URL;
   *  optional for self-hosted sqld with auth disabled and for `file:` URLs. */
  LIBSQL_AUTH_TOKEN?: string;
  // Cloudflare bindings — present only when running on Workers.
  D1?: D1Database;
  R2?: R2Bucket;
  /** One Vectorize index per embedding model — see packages/core/src/embedding-models.ts.
   *  `VECTORIZE_OPENAI` (1536, cosine) — OpenAI text-embedding-3-small;
   *  `VECTORIZE_OPENAI_LARGE` (3072, cosine) — OpenAI text-embedding-3-large;
   *  `VECTORIZE_BGE_M3` (1024, cosine) — Workers AI bge-m3;
   *  `VECTORIZE_SELF_HOST_BGE_M3` (1024, cosine) — self-hosted bge-m3
   *  (TEI/Ollama/etc); separate index because vectors from a different
   *  build of the same model still live in a disjoint space.
   *  Each is optional; a model whose index isn't bound errors on use. */
  VECTORIZE_OPENAI?: VectorizeIndex;
  VECTORIZE_OPENAI_LARGE?: VectorizeIndex;
  VECTORIZE_BGE_M3?: VectorizeIndex;
  VECTORIZE_SELF_HOST_BGE_M3?: VectorizeIndex;
  HYPERDRIVE?: Hyperdrive;
  /** Optional read-replica Hyperdrive binding. When present (Workers only),
   *  `ctx.dbRead` is built from its connection string; takes precedence over
   *  `DATABASE_REPLICA_URL`. Wire in `wrangler.toml` exactly like `HYPERDRIVE`
   *  but pointed at the replica's Hyperdrive config. */
  HYPERDRIVE_REPLICA?: Hyperdrive;
  REALTIME?: DurableObjectNamespace;
  /** Per-key counter for the rate limiter (`lib/rate-limit.ts`). One DO per
   *  `(label, ip)` key — collapses isolate-rotation drift into a single
   *  authoritative window. Bound on Workers via `wrangler.toml::RATE_LIMIT`;
   *  absent on Bun / Vercel / Netlify, where the limiter falls back to an
   *  in-process Map (per-process counter is fine — no isolate fan-out). */
  RATE_LIMIT?: DurableObjectNamespace;
  /** Cloudflare Workers AI binding. Required for the `bge-m3` model
   *  (`@cf/baai/bge-m3`). Add `[ai] binding = "AI"` in wrangler.toml. */
  AI?: Ai;
  // Optional AI provider keys.
  OPENAI_API_KEY?: string;
  /** Vercel AI Gateway API key — preferred multi-provider credential.
   *  When set, every `ai.*` MCP tool, the Ask AI planner, and any future
   *  AI-SDK caller routes through https://ai-gateway.vercel.sh and accepts
   *  provider-prefixed model ids (`anthropic/claude-haiku-4-5`,
   *  `openai/gpt-5`, `google/gemini-2.5-pro`, …). One key reaches every
   *  upstream. See docs/ask-ai.md. */
  AI_GATEWAY_API_KEY?: string;
  /** Legacy direct-Anthropic API key. Kept as a fallback so workspaces
   *  already configured with `ANTHROPIC_API_KEY` keep working without
   *  reissuing credentials. New deployments should prefer
   *  `AI_GATEWAY_API_KEY`. Also still powers the "Auto-translate missing"
   *  action in the Translations admin page, which hard-codes the
   *  Anthropic client. */
  ANTHROPIC_API_KEY?: string;
  /** Base URL of a self-hosted, OpenAI-compatible embeddings container
   *  (e.g. HuggingFace TEI, Ollama, vLLM, LiteLLM). The adapter posts to
   *  `${EMBEDDING_HTTP_URL}/v1/embeddings`. Required to use any model whose
   *  registry entry has `provider: "self-host"`. Text never leaves the
   *  user's infrastructure. */
  EMBEDDING_HTTP_URL?: string;
  /** Optional bearer token for the self-host embeddings endpoint. Leave
   *  unset for un-authed containers on a private network. */
  EMBEDDING_HTTP_TOKEN?: string;
  /** Default embedding model for collections that have `vectorize: true`
   *  but no per-collection `vectorize_model` set. Must be a key from
   *  `EMBEDDING_MODELS` (`bge-m3`, `openai-3-small`, `openai-3-large`,
   *  `self-host-bge-m3`). When unset, vectorize-enabled collections without
   *  a model are silently skipped. */
  EMBEDDING_DEFAULT_MODEL?: string;
  // Email transport. `EMAIL_PROVIDER` picks one explicitly: `console`,
  // `resend`, `sendgrid`, `mailgun`, or `ses`. When unset, the adapter is
  // auto-detected from whichever provider's credentials are present
  // (priority: resend → sendgrid → mailgun → ses), falling back to the
  // console adapter (logs to stdout). Every provider also needs `EMAIL_FROM`.
  EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  // Resend — https://resend.com
  RESEND_API_KEY?: string;
  // SendGrid — https://sendgrid.com (Mail Send v3 API)
  SENDGRID_API_KEY?: string;
  // Mailgun — https://mailgun.com. `MAILGUN_DOMAIN` is the sending domain;
  // `MAILGUN_HOST` is `api.mailgun.net` (default) or `api.eu.mailgun.net`.
  MAILGUN_API_KEY?: string;
  MAILGUN_DOMAIN?: string;
  MAILGUN_HOST?: string;
  // Amazon SES v2 — needs an IAM key with `ses:SendEmail` in a region where
  // SES is enabled and `EMAIL_FROM`'s address/domain is verified.
  SES_REGION?: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  // Generic SMTP (via nodemailer). Works on Bun / Vercel / Netlify / self-host
  // — NOT on Cloudflare Workers (no raw TCP sockets). `SMTP_SECURE=true` for
  // implicit TLS (port 465); leave false for 587/25 (STARTTLS auto-upgraded).
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_SECURE?: string;
  // OAuth providers. Each provider is enabled iff both id+secret are set.
  OAUTH_GOOGLE_CLIENT_ID?: string;
  OAUTH_GOOGLE_CLIENT_SECRET?: string;
  OAUTH_GITHUB_CLIENT_ID?: string;
  OAUTH_GITHUB_CLIENT_SECRET?: string;
  OAUTH_APPLE_CLIENT_ID?: string;
  OAUTH_APPLE_CLIENT_SECRET?: string;
  /** Comma-separated better-auth plugin names: `magic-link,email-otp,anonymous`. */
  AUTH_PLUGINS?: string;
  /** Comma-separated extra origins (scheme://host[:port]) allowed to make
   *  cross-origin requests with credentials — on top of `APP_URL` and the
   *  origins derived from each workspace's `auth_config.redirectUrls`. Set
   *  this for customer apps hosted on a different domain than the API. */
  EXTRA_TRUSTED_ORIGINS?: string;
  /** Comma-separated host allow-list for `ctx.fetch` inside functions.
   *  `*` allows any host (development only). Empty disables outbound fetch. */
  FUNCTIONS_FETCH_ALLOW?: string;
  /** HTTP base URL of an out-of-isolate function executor (e.g. the
   *  `templates/fn-exec-server` Bun process on Fly / Railway / a VM). When
   *  set, the `remote-http` sandbox provider POSTs invocations to
   *  `${FUNCTIONS_EXEC_URL}/run` — lets the API run on an edge runtime (CF
   *  Workers / Vercel Edge / Netlify Edge) while still offering DB-aware
   *  functions. Pairs with `SANDBOX_RPC_TOKEN` + `SELF_URL` for `ctx.*`. */
  FUNCTIONS_EXEC_URL?: string;
  /** Shared secret authenticating executor → main Worker RPC calls
   *  (`/api/_internal/sandbox-rpc`). Required for the `remote-http`
   *  provider's ctx.* host bridge. Generate with `openssl rand -hex 32`. */
  SANDBOX_RPC_TOKEN?: string;
  /** Public origin of the main Worker — used by the executor to call back
   *  for ctx.* RPC. Defaults to the request origin when invoked over HTTP;
   *  cron triggers must set this explicitly (no incoming request to
   *  derive from). */
  SELF_URL?: string;
  /** Public base URL of the R2 bucket (or any HTTP origin serving the same
   *  objects). When set on Workers, the storage GET route can ask Cloudflare
   *  Image Resizing to transform the source through that origin instead of
   *  shipping bytes through the Worker. Only used when the file's ACL is
   *  `public` — private files would need a signed origin first. */
  R2_PUBLIC_BASE?: string;
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
