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
  /** PKCS#8 PEM (EC P-256 → ES256, or RSA → RS256). When set, app-plane access
   *  tokens are signed with this key instead of HS256 and the public half is
   *  published at `/.well-known/jwks.json`, so other services can verify a
   *  backlex token without a shared secret. See lib/jwt-keys.ts. */
  AUTH_JWT_PRIVATE_KEY?: string;
  /** Extra SPKI PEM public keys (concatenate several for rotation). Published
   *  in the JWKS and accepted at verification, so tokens signed by a key that
   *  has just been rotated out still work until they expire. */
  AUTH_JWT_PUBLIC_KEYS?: string;
  /** When set, a request carrying `x-backlex-timing: <this>` gets the per-phase
   *  `Server-Timing` header (diagnostic). Unset (default) → timings are never
   *  collected or emitted, so internal phase latencies aren't disclosed. */
  DEBUG_TIMING_SECRET?: string;
  /** Structured-log verbosity threshold: `debug` | `info` (default) | `warn` |
   *  `error` | `silent`. Controls the per-request JSON access log + internal
   *  diagnostic lines (see lib/log.ts). `warn` mutes the access log but keeps
   *  warnings/errors; `debug` adds health-check lines; `silent` mutes all. */
  LOG_LEVEL?: string;
  /** Fraction (`0`..`1`) of requests whose trace span is persisted for the admin
   *  Traces panel. Unset → `1` (record every request; the write is non-blocking
   *  and rows are pruned). Set lower (e.g. `0.1`) on very high-traffic
   *  instances. See services/traces.ts + docs/tracing.md. */
  TRACES_SAMPLE_RATE?: string;
  /** Days to keep span rows before `cronTick` prunes them. Unset → `7`. `0`
   *  disables pruning (keep forever — bound the table yourself). */
  TRACES_RETENTION_DAYS?: string;
  /** OTLP/HTTP collector base URL (e.g. `https://otel.example.com` — `/v1/traces`
   *  is appended). When set, every persisted span is also exported to the
   *  external OpenTelemetry collector. Unset → no export. See services/otlp.ts. */
  OTLP_ENDPOINT?: string;
  /** Optional `key=value,key2=value2` headers for the OTLP export request
   *  (same format as `OTEL_EXPORTER_OTLP_HEADERS`) — auth tokens etc. */
  OTLP_HEADERS?: string;
  /** Schema-template id set by the cloud provisioner; the first workspace of a
   *  fresh install seeds the matching collections (zero-touch). */
  SEED_TEMPLATE?: string;
  /** Email pinned by the cloud provisioner as the only address allowed to claim
   *  the first-admin account on a fresh instance (prevents a stranger from
   *  claiming a public instance URL first). Unset on self-host → any first
   *  visitor may claim. */
  OWNER_EMAIL?: string;
  /** `"1"`/`"true"` flips the instance into playground (demo) mode: the demo
   *  admin account is auto-provisioned, its credentials are published on the
   *  public auth surface (one-click sign-in), outbound/destructive endpoints
   *  are blocked, and the whole workspace is wiped + re-seeded from
   *  `SEED_TEMPLATE` on a timer. Never set this on a real instance — it makes
   *  the admin account public by design. See services/demo.ts. */
  DEMO_MODE?: string;
  /** Demo-admin email published on the sign-in screen in demo mode.
   *  Unset → `demo@backlex.com`. */
  DEMO_EMAIL?: string;
  /** Demo-admin password published on the sign-in screen in demo mode.
   *  Unset → `playground`. It is public by design — DEMO_MODE only. */
  DEMO_PASSWORD?: string;
  /** Minutes between playground wipes (demo mode only). Unset → `60`. */
  DEMO_RESET_MINUTES?: string;
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
  /** Static Assets binding (CF Workers). Used to serve the SPA `index.html`
   *  for worker-handled SPA paths like the public dashboard embed, so the
   *  Worker controls their security headers (framable CSP). */
  ASSETS?: Fetcher;
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

  /** External vector stores. Both are PER-MODEL, for the same reason Vectorize
   *  is: an index/collection fixes its vector dimension at creation, so one
   *  cannot hold two embedding models. A model with no entry errors on use
   *  rather than writing into the wrong space.
   *
   *  Precedence in `buildContext`: Vectorize bindings → Pinecone → Qdrant →
   *  pgvector (implicit on Postgres) → libSQL (implicit on Turso) → none.
   *  Explicitly-configured stores win over the dialect's implicit one. */
  PINECONE_API_KEY?: string;
  /** Index HOST, not name — e.g. `my-idx-abc123.svc.us-east-1.pinecone.io`.
   *  Pinecone's data plane is addressed per index; taking the host avoids a
   *  control-plane lookup on every cold start. */
  PINECONE_INDEX_OPENAI?: string;
  PINECONE_INDEX_OPENAI_LARGE?: string;
  PINECONE_INDEX_BGE_M3?: string;
  PINECONE_INDEX_SELF_HOST_BGE_M3?: string;
  /** Base URL including port, e.g. `https://xyz.eu-central.aws.cloud.qdrant.io:6333`. */
  QDRANT_URL?: string;
  QDRANT_API_KEY?: string;
  QDRANT_COLLECTION_OPENAI?: string;
  QDRANT_COLLECTION_OPENAI_LARGE?: string;
  QDRANT_COLLECTION_BGE_M3?: string;
  QDRANT_COLLECTION_SELF_HOST_BGE_M3?: string;
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

  /** Opt-in observability reporting to the backlex cloud control plane.
   *  ONLY set when provisioned as a managed cloud tenant — self-hosted installs
   *  leave these unset and never report anything (see lib/cloud-report.ts). */
  CLOUD_REPORT_URL?: string;
  CLOUD_REPORT_SECRET?: string;
  CLOUD_PROJECT_ID?: string;
  /** When set (any non-empty value), server-side fetches to admin-supplied URLs
   *  (outbound webhooks, flow `request`/`webhook` ops) refuse private/internal/
   *  metadata hosts and re-validate redirects — an SSRF guard. Auto-enabled on
   *  managed cloud tenants (where `CLOUD_PROJECT_ID` is set), since a tenant
   *  admin there is not the host operator. Self-hosted installs leave it unset
   *  so legitimate internal webhook receivers keep working. */
  BLOCK_PRIVATE_FETCH_HOSTS?: string;
  /** Service Binding to the control-plane worker. Preferred delivery channel on
   *  Workers for Platforms, where a tenant runs inside the dispatch namespace
   *  and a plain fetch to the public hostname loops back (HTTP 522). */
  CLOUD_REPORT_SERVICE?: Fetcher;
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
  /** Short-lived Anthropic OAuth bearer token, used instead of a long-lived
   *  API key. Sent as `Authorization: Bearer` (never alongside `x-api-key` —
   *  the API rejects both). Mint one with `ant auth print-credentials
   *  --access-token`, or from a federation exchange in CI.
   *
   *  It EXPIRES and nothing here refreshes it, so it suits local dev and
   *  short-lived jobs; a long-running deployment wants `AI_GATEWAY_API_KEY`
   *  or `ANTHROPIC_API_KEY`. Lower precedence than both. */
  ANTHROPIC_AUTH_TOKEN?: string;
  /** Direct Google AI Studio (Gemini) API key. Only used for generation when
   *  the provider is picked explicitly via {@link Env.AI_PROVIDER} or a
   *  workspace BYO config — it is deliberately NOT part of the ambient
   *  auto-detect chain (see `AI_PROVIDER`). */
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  /** Force which entry of the AI provider registry (`services/ai-providers.ts`)
   *  generation runs on: `gateway` | `anthropic` | `openai` | `google`.
   *
   *  Without it, credentials are auto-detected in the historical order
   *  (`AI_GATEWAY_API_KEY` → `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN`).
   *  That chain deliberately does NOT sniff `OPENAI_API_KEY`, which many
   *  deployments already set purely for embeddings — silently promoting it to
   *  the generation credential would reroute (and re-bill) every AI feature.
   *  Setting `AI_PROVIDER` is the explicit opt-in; a workspace's bring-your-own
   *  provider choice sets it internally via `applyAiOverride`.
   *
   *  An unknown value, or a value whose key is missing, falls back to the
   *  auto-detect chain rather than failing. */
  AI_PROVIDER?: string;
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
  // Cloudflare Turnstile — spam guard for public form submissions. The site
  // key is public (returned to the form page so it can render the widget);
  // the secret key verifies challenge responses server-side. A form with
  // turnstile enabled fails closed when the secret is missing.
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_SECURE?: string;
  // Push notifications. `PUSH_PROVIDER` forces a single transport (`console`,
  // `fcm`, `apns`, `web-push`); when unset, every provider with complete
  // credentials below is composed into one fan-out adapter (Android via fcm,
  // iOS via apns, browsers via web-push), falling back to `console`.
  PUSH_PROVIDER?: string;
  // Firebase Cloud Messaging (HTTP v1) — from the service-account JSON.
  // `FCM_PRIVATE_KEY` is the PKCS8 PEM `private_key` (newlines preserved).
  FCM_PROJECT_ID?: string;
  FCM_CLIENT_EMAIL?: string;
  FCM_PRIVATE_KEY?: string;
  // Apple Push Notification service, token-based auth. `APNS_PRIVATE_KEY` is the
  // .p8 (EC P-256, PKCS8 PEM). Direct APNs needs an HTTP/2-capable runtime
  // (Cloudflare Workers); on Node/Bun route iOS through FCM instead.
  // `APNS_PRODUCTION=false` targets the sandbox gateway.
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_BUNDLE_ID?: string;
  APNS_PRODUCTION?: string;
  // Web Push (VAPID) — the standard `npx web-push generate-vapid-keys` output.
  // `WEBPUSH_SUBJECT` is a `mailto:` or origin URL; `WEBPUSH_VAPID_PUBLIC_KEY`
  // and `WEBPUSH_VAPID_PRIVATE_KEY` are both raw base64url (public = P-256
  // point, private = 32-byte scalar) — NOT a PEM.
  WEBPUSH_SUBJECT?: string;
  WEBPUSH_VAPID_PUBLIC_KEY?: string;
  WEBPUSH_VAPID_PRIVATE_KEY?: string;
  // SMS. `SMS_PROVIDER` forces a single transport (`console`, `twilio`, `sns`,
  // `netgsm`, `iletimerkezi`); when unset the first provider below with complete
  // credentials is used (twilio → sns → netgsm → iletimerkezi), falling back to
  // `console`.
  SMS_PROVIDER?: string;
  // ── PDF rendering (document generation) ────────────────────────────────
  // `PDF_PROVIDER` pins one; otherwise the first with usable credentials wins
  // (cf-browser → gotenberg). No fallback renderer exists on purpose — see the
  // note in `packages/core/src/adapters/pdf.ts`; an unconfigured deployment
  // refuses to render rather than producing a document with broken glyphs.
  PDF_PROVIDER?: string;
  // Cloudflare Browser Rendering, over its REST API (works from every runtime,
  // not just Workers). The token needs the "Browser Rendering — Edit" scope.
  PDF_CF_ACCOUNT_ID?: string;
  PDF_CF_API_TOKEN?: string;
  // Gotenberg — self-hosted Chromium behind HTTP. `PDF_GOTENBERG_URL` is the
  // service root (e.g. http://gotenberg:3000); the basic-auth pair is optional
  // and only needed if it sits behind one.
  PDF_GOTENBERG_URL?: string;
  PDF_GOTENBERG_USER?: string;
  PDF_GOTENBERG_PASS?: string;
  // ── Geocoding (address ⇄ point, for `geo` fields) ──────────────────────
  // `GEOCODE_PROVIDER` pins one (`google`, `mapbox`, `nominatim`, `console`);
  // otherwise the first with credentials wins (google → mapbox), then a
  // self-hosted Nominatim if `GEOCODE_URL` is set, else `console` (resolves
  // nothing). The public Nominatim is never the automatic default: its usage
  // policy forbids the bulk traffic a `geocodeFrom` backfill produces, so
  // reaching it takes an explicit `GEOCODE_PROVIDER=nominatim`.
  GEOCODE_PROVIDER?: string;
  GEOCODE_GOOGLE_API_KEY?: string;
  GEOCODE_MAPBOX_TOKEN?: string;
  // Nominatim instance root (e.g. http://nominatim:8080). Setting it opts into
  // Nominatim without pinning the provider.
  GEOCODE_URL?: string;
  // Identifying User-Agent — required by the public Nominatim. Defaults to
  // `backlex (<APP_URL>)`.
  GEOCODE_USER_AGENT?: string;
  // Optional result-language and country bias, passed to whichever provider is
  // active (all three accept an equivalent).
  GEOCODE_LANGUAGE?: string;
  GEOCODE_COUNTRY?: string;
  // Twilio Programmable Messaging — `TWILIO_FROM` is an E.164 number or approved
  // alphanumeric sender id; alternatively set `TWILIO_MESSAGING_SERVICE_SID`
  // (MGxxxx) to use a Messaging Service sender pool.
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM?: string;
  TWILIO_MESSAGING_SERVICE_SID?: string;
  // Amazon SNS SMS (AWS Signature V4 over the Query API). `SMS_AWS_SENDER_ID` is
  // an optional alphanumeric sender id (supported only in some countries). Note
  // the `SMS_` prefix avoids clashing with any ambient AWS_* deploy vars.
  SMS_AWS_REGION?: string;
  SMS_AWS_ACCESS_KEY_ID?: string;
  SMS_AWS_SECRET_ACCESS_KEY?: string;
  SMS_AWS_SENDER_ID?: string;
  // NetGSM (TR) — panel user code + password; `NETGSM_MSGHEADER` is the
  // pre-approved alphanumeric sender header (başlık) registered with NetGSM.
  NETGSM_USERCODE?: string;
  NETGSM_PASSWORD?: string;
  NETGSM_MSGHEADER?: string;
  // İleti Merkezi (TR) — panel API key + hash; `ILETIMERKEZI_SENDER` is the
  // pre-approved originator title.
  ILETIMERKEZI_KEY?: string;
  ILETIMERKEZI_HASH?: string;
  ILETIMERKEZI_SENDER?: string;
  // OAuth providers. Each provider is enabled iff both id+secret are set.
  OAUTH_GOOGLE_CLIENT_ID?: string;
  OAUTH_GOOGLE_CLIENT_SECRET?: string;
  OAUTH_GITHUB_CLIENT_ID?: string;
  OAUTH_GITHUB_CLIENT_SECRET?: string;
  OAUTH_APPLE_CLIENT_ID?: string;
  OAUTH_APPLE_CLIENT_SECRET?: string;
  /** Comma-separated better-auth plugin names: `passkey,magic-link,email-otp,anonymous`.
   *  TOTP two-factor is NOT listed here — it's loaded unconditionally (always
   *  available; users opt in from Account → Security). */
  AUTH_PLUGINS?: string;
  // Global per-identity rate limit on the `/api/*` data surface (abuse / runaway
  // guard, distinct from the per-IP auth limiter). See lib/api-rate-limit.ts.
  /** Max `/api/*` calls per identity (API key → user → IP) per window. Setting
   *  this also ENABLES the limiter on any deploy. Default 600. */
  API_RATE_LIMIT_MAX?: string;
  /** Sliding window in ms for the global API limit. Default 60000 (1 min). */
  API_RATE_LIMIT_WINDOW_MS?: string;
  /** Force the global API limiter OFF even where it would auto-enable (managed
   *  cloud). Truthy = disabled. Self-host is off by default regardless. */
  API_RATE_LIMIT_DISABLED?: string;
  // Workspace usage limits (#12). Env values are platform-set overrides — on
  // managed cloud the control plane injects the tenant's plan here; when a key
  // is present it WINS over the admin-editable `usageLimits` app-setting.
  // All optional; a missing key falls through to settings, then to unlimited.
  /** `off` | `soft` | `hard`. `hard` blocks over-limit traffic with 429
   *  QUOTA_EXCEEDED; `soft` only surfaces the overage in the usage API/UI. */
  USAGE_LIMIT_MODE?: string;
  /** Max metered `/api/*` requests per workspace per UTC month. */
  USAGE_LIMIT_REQUESTS_MONTH?: string;
  /** Max total stored file bytes per workspace (enforced on upload). */
  USAGE_LIMIT_STORAGE_BYTES?: string;
  /** Max total collection rows per workspace (enforced on item create,
   *  against the sweep gauge — approximate by design). */
  USAGE_LIMIT_DB_ROWS?: string;
  // Failed-login account lockout (abuse protection). Layered on top of the
  // per-IP auth rate limiter: tracks failed password attempts per identifier
  // and temporarily locks that account (across IPs) after MAX_FAILS failures
  // within WINDOW_MS, with exponential backoff (COOLDOWN_MS doubling up to
  // MAX_COOLDOWN_MS). A successful sign-in clears the counter. On by default;
  // set AUTH_LOCKOUT_DISABLED=true to turn it off.
  AUTH_LOCKOUT_DISABLED?: string;
  AUTH_LOCKOUT_MAX_FAILS?: string;
  AUTH_LOCKOUT_WINDOW_MS?: string;
  AUTH_LOCKOUT_COOLDOWN_MS?: string;
  AUTH_LOCKOUT_MAX_COOLDOWN_MS?: string;
  // Durable job queue. Jobs are drained by the cross-runtime cron tick
  // (`processJobs`), retried with exponential backoff, and dead-lettered after
  // `JOB_MAX_ATTEMPTS` tries. All optional with sane defaults.
  /** Default max delivery attempts before a job is dead-lettered. Default 5. */
  JOB_MAX_ATTEMPTS?: string;
  /** Backoff base in ms; retry N waits `base * 2^(N-1)` (±10% jitter). Default 60000. */
  JOB_BACKOFF_BASE_MS?: string;
  /** Backoff ceiling in ms. Default 3600000 (1h). */
  JOB_BACKOFF_MAX_MS?: string;
  /** Max jobs claimed+run per tick. Default 25. */
  JOB_BATCH?: string;
  /** Lease in ms; a job stuck `active` longer than this is reclaimed. Default 300000. */
  JOB_LEASE_MS?: string;
  // Resumable uploads (TUS 1.0.0). Sessions are tracked in the `uploads` table,
  // backed by native object-store multipart, and swept by the cron tick. All
  // optional with sane defaults.
  /** Max total bytes for a single resumable upload (TUS `Tus-Max-Size`). Default 5 GiB. */
  UPLOAD_MAX_BYTES?: string;
  /** Minimum non-final part size for object backends (S3/R2 require ≥5 MiB). Default 5 MiB. */
  UPLOAD_MIN_PART_BYTES?: string;
  /** Idle TTL in ms before an unfinished upload is aborted + swept. Default 86400000 (24h). */
  UPLOAD_TTL_MS?: string;
  /** Max parts per upload (S3 limit is 10000). Default 10000. */
  UPLOAD_PART_MAX?: string;
  /** Global ceiling for one anonymous public-form file upload, in bytes. A
   *  form block's own `maxBytes` can only clamp below this. Default 5 MiB. */
  FORM_UPLOAD_MAX_BYTES?: string;
  /** Per-form daily budget of anonymous uploads (abuse valve). Default 500. */
  FORM_UPLOAD_MAX_PER_DAY?: string;
  /** Control-plane (admin) SAML/LDAP SSO toggle. Enabled unless explicitly set
   *  to `"false"`/`"0"` — so self-host gets it by default. The cloud injects
   *  `"false"` for projects on plans without enterprise SSO (Free/Pro). */
  PLATFORM_SSO_ENABLED?: string;
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
  /** npm registry base URL extension installs resolve against. Defaults to
   *  https://registry.npmjs.org; point at a private registry mirror to gate
   *  which packages `POST /api/extensions/install` may pull. */
  EXTENSIONS_NPM_REGISTRY?: string;
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
  /** Upstash Redis (REST) — durable cross-instance realtime transport for
   *  stateless serverless runtimes (Vercel / Netlify Functions) where the
   *  in-process pub/sub map doesn't survive between invocations and there's no
   *  Durable Object. When both are set, the realtime publish/subscribe path
   *  uses a Redis Stream per channel (XADD + XRANGE replay via `Last-Event-ID`)
   *  instead of returning 503. Unset on Bun (in-proc) / Workers (DO). */
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  /** Ably API key (`keyName:keySecret`) — collaboration transport for
   *  stateless serverless runtimes. When set (and no Durable Object /
   *  long-lived process is available), the admin's collab channels ride Ably:
   *  the server only mints scoped token requests (`POST
   *  /api/realtime/collab-token`), the browser connects to Ably directly, so
   *  awareness traffic costs zero function invocations. The key secret never
   *  reaches the client. */
  ABLY_API_KEY?: string;
  /** Who may subscribe to the signal-only data plane (`signal:items:<slug>`,
   *  the Ably realtime path on stateless serverless).
   *
   *  - `unconditional` (default) — only subscribers whose `read` permission on
   *    the collection carries NO row condition. They can already enumerate the
   *    collection's ids over REST, so an id-only change signal tells them
   *    nothing new. A conditioned role is refused a token and degrades to no
   *    realtime.
   *  - `all` — waive that check. Row DATA still never leaks (the client
   *    refetches through the permission-filtered REST path), but a conditioned
   *    subscriber does learn the ids and timing of changes to rows its
   *    condition hides. Set this only when that's not sensitive. */
  REALTIME_SIGNAL_SCOPE?: "unconditional" | "all";
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
  /** Days of sensitive-read audit (`access.*`) history to keep. These rows are
   *  higher-volume and opt-in per collection, so they get a shorter clock than
   *  the global retention. Pruned by the same daily cron tick. Defaults to 30.
   *  Set to `0` to disable (rows then fall back to ACTIVITY_RETENTION_DAYS). */
  ACCESS_AUDIT_RETENTION_DAYS?: string;
  /** Days of tracked product-analytics events to keep. The stream is the
   *  highest-volume table backlex writes, and the aggregates that matter
   *  (funnels, retention) are windowed anyway. Defaults to 90. */
  ANALYTICS_RETENTION_DAYS?: string;
  /** Days of captured error occurrences (stacks + context) to keep. Groups
   *  outlive their occurrences — only a group with nothing left AND no sighting
   *  since the cutoff is dropped — so an active bug keeps its full lifetime
   *  counter. Defaults to 90. */
  ERRORS_RETENTION_DAYS?: string;
  /** How much of the MCP surface earns an audit row (`mcp.*` in the activity
   *  log). `all` = every `tools/call` plus every `resources/read`; `writes`
   *  (default) = write/destruct calls only; `off` = none. Guard refusals
   *  (`mcp.denied`) and tool errors (`mcp.error`) are recorded at every level —
   *  those are the security-relevant events and dropping them would defeat the
   *  point. */
  MCP_AUDIT_LEVEL?: string;
  /** Days of MCP audit (`mcp.*`) history to keep. Agent loops are chatty, so
   *  these rows get a shorter clock than the global retention, on the same
   *  daily cron tick. Defaults to 30. Set to `0` to disable (rows then fall
   *  back to ACTIVITY_RETENTION_DAYS). */
  MCP_AUDIT_RETENTION_DAYS?: string;
  /** Set to `"true"` to let the server-side migration connector dial
   *  private/internal addresses (localhost, RFC1918, link-local, ULA). Off
   *  by default — a hosted admin must not be able to use the server as a
   *  proxy into the platform's own network (SSRF). Self-hosters whose
   *  source DB lives next to backlex opt in; the `backlex import-db` CLI
   *  is unaffected (it runs on the user's machine). */
  MIGRATE_ALLOW_PRIVATE_SOURCES?: string;
}

/**
 * Every string-valued config field on {@link Env} — i.e. everything an
 * environment-variable source (`process.env`, `Deno.env`) can supply. The
 * Cloudflare *binding* fields (D1 / R2 / ASSETS / AI / VECTORIZE_* /
 * HYPERDRIVE* / REALTIME / RATE_LIMIT / CLOUD_REPORT_SERVICE) are objects the
 * Workers runtime injects and are intentionally absent here.
 *
 * `envFromSource` maps exactly these keys, so the non-Worker entries
 * (bun/node/vercel/netlify/deno/gcp/lambda/azure) no longer hand-list a stale
 * subset — historically each one mapped ~34 of ~100 keys, silently dropping
 * SMTP/SES/push/SMS/OWNER_EMAIL/SSRF/AI-gateway/embedding/retention/job/upload
 * knobs. `tests/env-parity.test.ts` parses the interface and fails if a new
 * string field is added without being listed here. The `satisfies` clause
 * guarantees every entry is a real `Env` key.
 */
export const STRING_ENV_KEYS = [
  "APP_URL",
  "AUTH_SECRET",
  "AUTH_JWT_PRIVATE_KEY",
  "AUTH_JWT_PUBLIC_KEYS",
  "DEBUG_TIMING_SECRET",
  "LOG_LEVEL",
  "TRACES_SAMPLE_RATE",
  "TRACES_RETENTION_DAYS",
  "OTLP_ENDPOINT",
  "OTLP_HEADERS",
  "SEED_TEMPLATE",
  "OWNER_EMAIL",
  "DEMO_MODE",
  "DEMO_EMAIL",
  "DEMO_PASSWORD",
  "DEMO_RESET_MINUTES",
  "DATABASE_URL",
  "DATABASE_REPLICA_URL",
  "DATABASE_DRIVER",
  "CRON_SECRET",
  "SQLITE_PATH",
  "LIBSQL_URL",
  "PINECONE_API_KEY",
  "PINECONE_INDEX_OPENAI",
  "PINECONE_INDEX_OPENAI_LARGE",
  "PINECONE_INDEX_BGE_M3",
  "PINECONE_INDEX_SELF_HOST_BGE_M3",
  "QDRANT_URL",
  "QDRANT_API_KEY",
  "QDRANT_COLLECTION_OPENAI",
  "QDRANT_COLLECTION_OPENAI_LARGE",
  "QDRANT_COLLECTION_BGE_M3",
  "QDRANT_COLLECTION_SELF_HOST_BGE_M3",
  "LIBSQL_AUTH_TOKEN",
  "CLOUD_REPORT_URL",
  "CLOUD_REPORT_SECRET",
  "CLOUD_PROJECT_ID",
  "BLOCK_PRIVATE_FETCH_HOSTS",
  "OPENAI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "AI_PROVIDER",
  "EMBEDDING_HTTP_URL",
  "EMBEDDING_HTTP_TOKEN",
  "EMBEDDING_DEFAULT_MODEL",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "RESEND_API_KEY",
  "SENDGRID_API_KEY",
  "MAILGUN_API_KEY",
  "MAILGUN_DOMAIN",
  "MAILGUN_HOST",
  "SES_REGION",
  "SES_ACCESS_KEY_ID",
  "SES_SECRET_ACCESS_KEY",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_SECURE",
  "PUSH_PROVIDER",
  "FCM_PROJECT_ID",
  "FCM_CLIENT_EMAIL",
  "FCM_PRIVATE_KEY",
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_PRIVATE_KEY",
  "APNS_BUNDLE_ID",
  "APNS_PRODUCTION",
  "WEBPUSH_SUBJECT",
  "WEBPUSH_VAPID_PUBLIC_KEY",
  "WEBPUSH_VAPID_PRIVATE_KEY",
  "PDF_PROVIDER",
  "PDF_CF_ACCOUNT_ID",
  "PDF_CF_API_TOKEN",
  "PDF_GOTENBERG_URL",
  "PDF_GOTENBERG_USER",
  "PDF_GOTENBERG_PASS",
  "GEOCODE_PROVIDER",
  "GEOCODE_GOOGLE_API_KEY",
  "GEOCODE_MAPBOX_TOKEN",
  "GEOCODE_URL",
  "GEOCODE_USER_AGENT",
  "GEOCODE_LANGUAGE",
  "GEOCODE_COUNTRY",
  "SMS_PROVIDER",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM",
  "TWILIO_MESSAGING_SERVICE_SID",
  "SMS_AWS_REGION",
  "SMS_AWS_ACCESS_KEY_ID",
  "SMS_AWS_SECRET_ACCESS_KEY",
  "SMS_AWS_SENDER_ID",
  "NETGSM_USERCODE",
  "NETGSM_PASSWORD",
  "NETGSM_MSGHEADER",
  "ILETIMERKEZI_KEY",
  "ILETIMERKEZI_HASH",
  "ILETIMERKEZI_SENDER",
  "OAUTH_GOOGLE_CLIENT_ID",
  "OAUTH_GOOGLE_CLIENT_SECRET",
  "OAUTH_GITHUB_CLIENT_ID",
  "OAUTH_GITHUB_CLIENT_SECRET",
  "OAUTH_APPLE_CLIENT_ID",
  "OAUTH_APPLE_CLIENT_SECRET",
  "AUTH_PLUGINS",
  "API_RATE_LIMIT_MAX",
  "API_RATE_LIMIT_WINDOW_MS",
  "API_RATE_LIMIT_DISABLED",
  "USAGE_LIMIT_MODE",
  "USAGE_LIMIT_REQUESTS_MONTH",
  "USAGE_LIMIT_STORAGE_BYTES",
  "USAGE_LIMIT_DB_ROWS",
  "AUTH_LOCKOUT_DISABLED",
  "AUTH_LOCKOUT_MAX_FAILS",
  "AUTH_LOCKOUT_WINDOW_MS",
  "AUTH_LOCKOUT_COOLDOWN_MS",
  "AUTH_LOCKOUT_MAX_COOLDOWN_MS",
  "JOB_MAX_ATTEMPTS",
  "JOB_BACKOFF_BASE_MS",
  "JOB_BACKOFF_MAX_MS",
  "JOB_BATCH",
  "JOB_LEASE_MS",
  "UPLOAD_MAX_BYTES",
  "UPLOAD_MIN_PART_BYTES",
  "UPLOAD_TTL_MS",
  "UPLOAD_PART_MAX",
  "FORM_UPLOAD_MAX_BYTES",
  "FORM_UPLOAD_MAX_PER_DAY",
  "PLATFORM_SSO_ENABLED",
  "EXTRA_TRUSTED_ORIGINS",
  "FUNCTIONS_FETCH_ALLOW",
  "FUNCTIONS_EXEC_URL",
  "EXTENSIONS_NPM_REGISTRY",
  "SANDBOX_RPC_TOKEN",
  "SELF_URL",
  "R2_PUBLIC_BASE",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "ABLY_API_KEY",
  "REALTIME_SIGNAL_SCOPE",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "ACTIVITY_RETENTION_DAYS",
  "ACCESS_AUDIT_RETENTION_DAYS",
  "ANALYTICS_RETENTION_DAYS",
  "ERRORS_RETENTION_DAYS",
  "MCP_AUDIT_LEVEL",
  "MCP_AUDIT_RETENTION_DAYS",
  "MIGRATE_ALLOW_PRIVATE_SOURCES",
] as const satisfies readonly (keyof Env)[];

/**
 * Build an {@link Env} from any string→string env source. Every key in
 * {@link STRING_ENV_KEYS} that's present in `src` is copied through; the
 * Cloudflare binding fields stay undefined (the Worker entry passes its raw
 * bindings object straight through and never calls this). Required fields
 * (`APP_URL`, `AUTH_SECRET`) are mapped here too but the callers still apply
 * their own dev-fallback so a bare local boot works.
 */
export const envFromSource = (
  src: Record<string, string | undefined>,
): Partial<Env> => {
  const out: Record<string, string | undefined> = {};
  for (const key of STRING_ENV_KEYS) {
    const v = src[key];
    if (v !== undefined) out[key] = v;
  }
  // `out` carries plain strings; the only non-string member is the
  // `DATABASE_DRIVER` union, which at runtime is whatever string the source
  // held (matching the prior `as Env["DATABASE_DRIVER"]` casts the entries did).
  return out as unknown as Partial<Env>;
};
