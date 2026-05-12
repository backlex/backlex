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
