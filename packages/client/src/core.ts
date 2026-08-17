import type { QueryBuilder } from "./query";
import type { TokenStore } from "./token-store";
import type { AggregateQuery, AggregateRow, BatchOperation, BatchResponse, BulkUpdateResponse, ChangesQuery, ChangesResponse, ImportSummary, ItemQuery, ItemResponse, ListQuery, ListResponse, SearchQuery, SearchResponse } from "./types";

/**
 * The shapes every domain client in `clients/` is written against, and the
 * handle they are all built from.
 *
 * `createClient` owns the transport — headers, the workspace token, the active
 * organization — and hands each domain module this one object. A domain module
 * therefore never sees `fetch`, an auth header, or another domain: adding an
 * endpoint is an edit to exactly one file.
 */
export interface ClientOptions {
  url: string;
  /** Static API key (`pak_...`) for server-to-server calls. Browser apps
   *  should rely on the cookie session / a workspace session token and omit
   *  this. */
  apiKey?: string;
  /**
   * Workspace slug. When set, the client operates in **app mode**: `auth.*`
   * targets that workspace's own auth surface (`/api/t/<slug>/auth/*`, the
   * "auth as a service" pool — distinct from the admin/control-plane auth),
   * and the session token returned by `auth.signUp` / `auth.signIn` is
   * captured and sent as `Authorization: Bearer <token>` on every subsequent
   * request (data + auth). Persist it across page loads with `auth.getToken()`
   * / restore it with `auth.setToken()`.
   */
  workspace?: string;
  /** Restore a previously-saved workspace session token (app mode). */
  token?: string;
  /**
   * Scope every request to a specific tenant/workspace by sending the
   * `X-Backlex-Tenant` header (slug or id). Needed for anonymous public reads
   * and for a `pak_` key addressing a tenant other than its home one. The server
   * ignores it for app-mode bearer sessions (the tenant comes from the session).
   */
  tenant?: string;
  /**
   * Publishable analytics ingest key (`alk_...`). Safe to ship in a browser or
   * mobile bundle: it authorises append-only `analytics.track` /
   * `analytics.trackError` calls and cannot read anything back. Omit it when
   * the client already carries a session or API key — ingest accepts those too.
   */
  ingestKey?: string;
  /**
   * Act inside a specific organization by sending the `X-Backlex-Org` header
   * (slug or id) on every request, so `$org.id` in permission rules resolves to
   * it. Only meaningful for app-plane sessions, and only accepted for orgs the
   * signed-in end-user actually belongs to. Change it later with
   * `client.orgs.use(...)`.
   */
  org?: string;
  /** Optional fetch override (testing / Node polyfill). */
  fetch?: typeof fetch;
  /**
   * Keep the app-mode session token across page loads.
   *
   * `true` picks the best store this runtime has — `localStorage` in a
   * browser, memory anywhere else, because a token on a server belongs to one
   * request and writing it process-wide would hand one caller's session to the
   * next. Pass a {@link TokenStore} for anything else: `cookieTokens()` when a
   * server needs to read the session during SSR, `sessionStorageTokens()` for
   * a shared machine, or your own for a native keychain.
   *
   * Restoring is automatic — the stored token is read at `createClient` — and
   * so is clearing, because `signOut` goes through the same one setter every
   * capture path does. An explicit `token` option still wins: a caller who
   * passed one knows something the store does not.
   */
  persist?: boolean | TokenStore;
  /**
   * Distributed tracing. When enabled (the default), every request carries a
   * W3C `traceparent` header so the call shows up in the admin Traces panel and
   * stitches together with any server-side spans it triggers. Set `false` to
   * omit the header entirely.
   *
   * Pass a function to control the trace context — return a `traceparent` value
   * to continue an existing trace (e.g. one already active in the browser), or
   * `undefined` to let the SDK start a fresh trace for that call. The default
   * starts a new trace per request.
   */
  tracing?: boolean | (() => string | undefined);
}

/** A signed-in user as returned by the auth surface. */
export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
}

/** Result of a sign-in / sign-up — the user and (app mode) the session token. */
export interface AuthResult {
  user: AuthUser;
  token?: string;
}

/** One active session (device/login) of the signed-in user. */
export interface AuthSession {
  id: string;
  token: string;
  userId: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A public sign-in provider as advertised by `auth.providers()`.
 *
 * `kind` is kept in step with the server's own union (`PublicProvider` in
 * `apps/web/src/server/services/auth-config.ts`) by
 * `apps/web/tests/auth-surface-parity.test.ts`. It had drifted: the server
 * emitted `saml`, `ldap` and `oidc` while this typed five kinds and no
 * `loginUrl`, so an application narrowing on `kind` dropped every SSO provider
 * its types had never heard of — silently, because the values were there.
 */
export interface PublicProvider {
  /** For `social` this is the better-auth provider name (`github`); for
   *  `oidc` and `saml` it is the workspace's own slug for that provider. */
  id: string;
  kind:
    | "credential"
    | "magic-link"
    | "email-otp"
    | "passkey"
    | "social"
    | "oidc"
    | "saml"
    | "ldap";
  label: string;
  enabled: boolean;
  /** Where to send the browser (SAML only). The other kinds are entered
   *  through an `auth.*` call — `signInSocial` for `social`, `signInOAuth2`
   *  for `oidc` — so they carry no URL. */
  loginUrl?: string;
}

/** Public description of a workspace's auth surface (provider list + policy). */
export interface AuthSurface {
  tenantId: string | null;
  providers: PublicProvider[];
  policy: { openSignup: boolean; requireEmailVerification: boolean } & Record<string, unknown>;
}

/** Write-time locale target for `localized` fields. */
export interface WriteLocaleOpts {
  /** When set, `localized` field values in the body are the native value for
   *  this one locale (upserted without disturbing other locales). Omit to send
   *  full `{locale: value}` maps. */
  locale?: string;
}

/** Options for `update()` — locale targeting plus optimistic concurrency. */
export interface WriteUpdateOpts extends WriteLocaleOpts {
  /** Optimistic-concurrency precondition: pass the `updatedAt` you loaded the
   *  row with; the server refuses with 409 CONFLICT when the row was modified
   *  since (instead of silently last-write-winning). */
  ifUnmodifiedSince?: string;
  /** Staged-edits collections: bypass staging and edit the live row of a
   *  published item directly. Requires the `publish` permission. */
  live?: boolean;
}

/** The per-collection data API returned by `client.from<T>(slug)`. Exported so
 *  generated SDKs (see `backlex gen-types --sdk`) and apps can name the shape. */
export interface CollectionClient<T extends Record<string, unknown>> {
  list(q?: ListQuery): Promise<ListResponse<T>>;
  /** Fluent, type-safe query builder that compiles to `ListQuery`. */
  query(): QueryBuilder<T>;
  /** Run a single-function aggregate (count/sum/avg/min/max), optionally grouped. */
  aggregate(body: AggregateQuery): Promise<{ data: AggregateRow[] }>;
  /** Relevance search — full-text, vector, or `hybrid` (RRF). Requires the
   *  matching capability enabled on the collection. Rows come back best-first
   *  with the caller's read permission + tenant scope enforced. */
  search(body: SearchQuery): Promise<SearchResponse<T>>;
  /** One page of the incremental changefeed. Rows changed past `since`, with
   *  soft-delete tombstones (`_deleted`) and — when a `shape` is given — id-only
   *  move-out markers (`_shape_exit`) for rows that left the subset. This is the
   *  raw primitive; `client.sync()` is the managed loop built on it. */
  changes(q?: ChangesQuery): Promise<ChangesResponse<T>>;
  /** Export every readable row as a JSON or CSV string. */
  exportItems(format?: "json" | "csv"): Promise<string>;
  /** Bulk-import rows from a JSON array (or a raw JSON/CSV string). */
  importItems(
    body: string | Partial<T>[],
    format?: "json" | "csv",
  ): Promise<ImportSummary>;
  one(id: string, opts?: ItemQuery): Promise<ItemResponse<T>>;
  /** Create a row. Pass `{ locale }` to write a single locale of every
   *  `localized` field (the field values are then the native per-locale value);
   *  omit it to send full `{locale: value}` maps. */
  create(data: Partial<T>, opts?: WriteLocaleOpts): Promise<ItemResponse<T>>;
  /** Update a row. Pass `{ locale }` to upsert a single locale of the
   *  `localized` fields in `patch` without disturbing the others. Pass
   *  `{ ifUnmodifiedSince }` (the `updatedAt` you loaded) to get a 409
   *  CONFLICT instead of overwriting someone else's concurrent save. */
  update(id: string, patch: Partial<T>, opts?: WriteUpdateOpts): Promise<ItemResponse<T>>;
  delete(id: string): Promise<{ ok: boolean }>;
  createMany(rows: Partial<T>[], opts?: { atomic?: boolean }): Promise<BatchResponse<T>>;
  updateMany(
    updates: { id: string; data: Partial<T> }[],
    opts?: { atomic?: boolean },
  ): Promise<BatchResponse<T>>;
  deleteMany(ids: string[], opts?: { atomic?: boolean }): Promise<BatchResponse<T>>;
  bulkUpdate(keys: string[], data: Partial<T>): Promise<BulkUpdateResponse>;
  batch(operations: BatchOperation<T>[], opts?: { atomic?: boolean }): Promise<BatchResponse<T>>;
  publish(id: string): Promise<ItemResponse<T>>;
  unpublish(id: string): Promise<ItemResponse<T>>;
  archive(id: string): Promise<ItemResponse<T>>;
  schedulePublish(id: string, at: Date | string | null): Promise<ItemResponse<T>>;
  scheduleUnpublish(id: string, at: Date | string | null): Promise<ItemResponse<T>>;
  /** Discard a staged-edits item's pending staged patch without applying it. */
  discardStaged(id: string): Promise<{ ok: boolean }>;
  /** Check a plaintext against the stored digest of a `hash` field on the row.
   *  The digest never leaves the server; this returns only `{ valid }`.
   *  Requires read permission on the item; the server throttles attempts. */
  verify(id: string, field: string, value: string): Promise<{ valid: boolean }>;
  /** Every status move this row could make right now, per lifecycle field —
   *  including the refused ones and why, so a UI can disable a button and say
   *  what is missing rather than simply omitting it. Judged for the CALLING
   *  identity: a move gated on a role you don't hold comes back
   *  `allowed: false`. Requires read permission on the item. */
  transitions(id: string): Promise<{ data: FieldTransitions[] }>;
  /** Restate this collection's `rollup` columns from the rows they aggregate.
   *  Ordinary writes keep rollups in step on their own — this is the repair
   *  path for rows written around the API (a restore, a bulk seed, direct SQL).
   *  Idempotent; returns the columns it refreshed. Requires `update`.
   *
   *  `{ async: true }` queues it as a durable background job instead and
   *  answers `{ jobId }` — hand that to `jobs.waitFor`. The job re-resolves
   *  `update` on the collection when it runs, so a revoked grant stops it. */
  refreshRollups(opts?: {
    async?: boolean;
  }): Promise<{ ok: boolean; refreshed?: string[]; jobId?: string; status?: string }>;
  /** Move this collection's `sequence` counters forward to the highest number
   *  already stored in each column. The repair path for a series that predates
   *  its counter — an adopted table, a restore, a bulk seed. Counters only ever
   *  move forward. Idempotent. Requires `update`. */
  syncSequences(): Promise<{ ok: boolean; synced: SequenceSyncReport[] }>;
  /** The value each sequence column would render next, without consuming it.
   *  A preview: another create can take that number first, so never write it. */
  nextSequences(): Promise<Record<string, string>>;
  /**
   * Move a row so it sits immediately before or after another in the same
   * hand-arranged list — the drag-and-drop primitive.
   *
   * State the INTENT, not the number: only the rows between the old place and
   * the new one are renumbered, and nothing else in the list moves. Both rows
   * must be in the same list; moving a row to a different one is a change to
   * the scope column, so use `update()`, which re-appends it to the end of the
   * list it joined.
   *
   * A list still holding duplicate positions — any collection whose `position`
   * column defaulted to 0 — is renumbered into the order it currently reads in
   * before the move, and that count comes back as `repaired`.
   *
   * Requires `update` on the collection.
   */
  reorder(
    field: string,
    id: string,
    to: { before: string } | { after: string },
  ): Promise<ReorderReport>;
  /**
   * Take a row out of play, or put it back.
   *
   * Writes the collection's retirement flag — the boolean declared with
   * `retire`, spelled `active` in most schemas.
   *
   * **This is not a delete and not a hide.** Every existing reference still
   * resolves, `get()` still returns the row, and `list()` still includes it
   * unless you ask it not to with `retired: "exclude"`. What changes is that
   * the row stops being OFFERED for new work: the admin's pickers skip it, and
   * a write pointing a NEW relation at it is refused with 422 unless the flag
   * declares `references: "allow"`.
   *
   * Requires an `update` grant that covers the flag column.
   */
  retire(id: string, opts?: { restore?: boolean }): Promise<RetireReport>;
  /** Renumber this collection's order fields into dense 1…N within each list,
   *  keeping the order the rows currently read in. The repair path for a column
   *  that predates being declared an order field. Idempotent; omit `field` to do
   *  all of them. Requires `update`. */
  normalizeOrder(field?: string): Promise<NormalizeOrderReport>;
  /** Fold a URL slug out of each row's source column for the rows whose slug
   *  field is empty — the repair path for a column that predates the field
   *  being declared a slug, which is every slug in the template catalog. A DRY
   *  RUN unless `apply` is true. Only ever FILLS an empty slug, never revises
   *  one, because the one already there may be a published URL — so re-running
   *  is safe. Requires `update` covering the slug column. */
  backfillSlugs(opts?: { field?: string; apply?: boolean }): Promise<SlugBackfillReport>;
  /** Geocode the rows that have an address (`geo.geocodeFrom`) and no point.
   *  Bounded per call — loop while `remaining > 0`. Only ever FILLS a missing
   *  point, never revises one, so re-running is safe and a hand-corrected pin
   *  survives it. Requires `update`. */
  backfillGeo(field: string, limit?: number): Promise<GeoBackfillReport>;
  /** The same backfill, queued: it works through the WHOLE collection across as
   *  many batches as it takes (queueing its own continuation) and answers a
   *  `jobId` for `jobs.waitFor`. The job re-resolves `update` on the collection
   *  every time it runs. Refused for API keys, workspace end-users and
   *  impersonation sessions — each narrows permissions in a way a background
   *  identity cannot reproduce; use the bounded `backfillGeo` for those. */
  backfillGeoAsync(
    field: string,
    limit?: number,
  ): Promise<{ jobId: string; status: string; field: string }>;
  /** Rewrite this collection's existing values of a `phone` field into
   *  canonical E.164 — the repair path for rows that predate the field being a
   *  phone field at all (an adopted table, a restore, a column that used to be
   *  plain text). Walks in primary-key order: loop while `cursor` is non-null,
   *  passing it back as `opts.after`. Values already canonical are skipped and
   *  unreadable ones are reported rather than guessed at, so re-running is safe.
   *  Requires `update`. */
  normalizePhones(
    field: string,
    opts?: { limit?: number; after?: string; dryRun?: boolean },
  ): Promise<PhoneNormalizeReport>;
  /** Rewrite this collection's existing values of an `email` field into
   *  canonical form (trimmed, folded, international domains encoded) — the
   *  repair path for rows that predate the field being an email field at all.
   *  Walks in primary-key order: loop while `cursor` is non-null, passing it
   *  back as `opts.after`. Values already canonical are skipped, unreadable ones
   *  are reported rather than guessed at, and on a `unique` column a value that
   *  would collide with another row is reported and left alone — so re-running
   *  is safe. Requires `update`. */
  normalizeEmails(
    field: string,
    opts?: { limit?: number; after?: string; dryRun?: boolean },
  ): Promise<EmailNormalizeReport>;
}

/**
 * The value of a `money` field — an amount in MAJOR units and the currency it
 * is denominated in. `19.99 USD` reads back as `{ amount: 19.99, currency:
 * "USD" }`, never as a bare number, because an amount without its currency is
 * what the field type exists to abolish.
 *
 * Writes accept more shapes than reads produce: a bare number (`19.99`), a
 * decimal string, `"19.99 USD"`, `{ amount, currency }`, or
 * `{ minor: 1999, currency }`. Amounts carrying more decimal places than the
 * currency has are refused rather than rounded.
 */
export interface MoneyValue {
  /** Major units — `19.99`, not `1999`. */
  amount: number;
  /** ISO-4217 alphabetic code, uppercase. */
  currency: string;
}

/**
 * Render a money value for a human, in the given locale.
 *
 * Deliberately the only money helper this SDK ships. Anything that ADDS money
 * belongs on the server: totals over rows are what `rollup` fields and
 * `aggregate` are for, and both refuse to mix currencies — a client-side sum
 * would be a second implementation of that rule, in floating point, with no way
 * to enforce it.
 */
export const formatMoney = (value: MoneyValue, locale = "en"): string => {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: value.currency,
    }).format(value.amount);
  } catch {
    return `${value.amount} ${value.currency}`;
  }
};

/** What {@link CollectionClient.backfillGeo} did in one bounded pass. */
export interface GeoBackfillReport {
  /** Rows given a point by this call. */
  located: number;
  /** Rows the provider could not place. Reported, not retried — an address it
   *  does not know will not become known by asking again. */
  unresolved: number;
  /** Rows whose address columns were all blank, so nothing was asked. */
  skipped: number;
  /** Rows still without a point. Loop until this is 0. */
  remaining: number;
}

/** What {@link CollectionClient.normalizePhones} did in one bounded page. */
export interface PhoneNormalizeReport {
  /** Rows examined by this call. */
  scanned: number;
  /** Rows rewritten into E.164 — or, on a dry run, that would be. */
  normalized: number;
  /** Rows whose value was already exactly canonical. */
  alreadyCanonical: number;
  /** Rows whose value could not be read as a phone number. Left untouched:
   *  overwriting an unparseable value destroys the only copy of it, and the
   *  operator who typed it is the one who can say what it meant. */
  unreadable: number;
  /** Ids of those rows, so they can be looked at. Capped at 200 per page. The
   *  VALUES are deliberately not returned — this report is a plausible thing to
   *  log, and each one is a real person's phone number. */
  unreadableIds: string[];
  /** Pass back as `after` for the next page. `null` means the walk is done. */
  cursor: string | null;
}

/** What {@link CollectionClient.normalizeEmails} did to one email column. */
export interface EmailNormalizeReport {
  /** Rows examined by this call. */
  scanned: number;
  /** Rows rewritten into canonical form — or, on a dry run, that would be. */
  normalized: number;
  /** Rows whose value was already exactly canonical. */
  alreadyCanonical: number;
  /** Rows whose value could not be read as an address. Left untouched:
   *  overwriting an unparseable value destroys the only copy of it, and the
   *  operator who typed it is the one who can say what it meant. */
  unreadable: number;
  /** Rows on a `unique` column whose folded value is already held by a DIFFERENT
   *  row — the duplicate the column was supposed to prevent and, while it was
   *  plain text, could not. Left untouched: which of the two is the real
   *  customer is a question about the business, and merging is irreversible. */
  collided: number;
  /** Ids of those rows, so they can be looked at. Capped at 200 per page each.
   *  The VALUES are deliberately not returned — this report is a plausible thing
   *  to log, and each one is a real person's address. */
  unreadableIds: string[];
  collidedIds: string[];
  /** Pass back as `after` for the next page. `null` means the walk is done. */
  cursor: string | null;
}

/** What {@link CollectionClient.syncSequences} did to one sequence column. */
export interface SequenceSyncReport {
  field: string;
  /** Reset periods whose counter was moved forward, and to what. */
  advanced: { scope: string; to: number }[];
  /** Stored values this field's pattern could not have produced, so they were
   *  left out of the maximum rather than guessed at. */
  unreadable: number;
}

/** What {@link CollectionClient.reorder} did. */
export interface ReorderReport {
  /** The position the row ended up on. */
  position: number;
  /** How many rows stepped aside to make room. Zero when the row was dropped
   *  next to where it already was, or one place away. */
  shifted: number;
  /** How many rows the tie repair renumbered before the move. Non-zero the
   *  first time a list that was never really ordered gets dragged. */
  repaired: number;
}

/** What {@link CollectionClient.retire} did. */
export interface RetireReport {
  /** The flag column that was written — `active` in most schemas. */
  field: string;
  /** Where the row ended up. */
  retired: boolean;
  /** The updated row, projected through the caller's READ grant. */
  data: Record<string, unknown>;
}

/** What {@link CollectionClient.normalizeOrder} did. */
export interface NormalizeOrderReport {
  /** Distinct lists examined, across every field touched. */
  scopes: number;
  /** Rows whose position changed. Zero on a second run. */
  renumbered: number;
  /** The order fields that were normalized. */
  fields: string[];
}

/** What {@link CollectionClient.backfillSlugs} did to one slug field. */
export interface SlugBackfillField {
  field: string;
  /** Rows found with an empty slug, within the caller's scope. */
  examined: number;
  /** Rows given one. */
  filled: number;
  /** Rows whose source text had no Latin letters to fold — reported, never
   *  given an invented token. */
  unfoldable: number;
  /** Sample of what was (or would be) written, capped at fifty. */
  entries: Array<{ id: string; slug: string }>;
}

/** What {@link CollectionClient.backfillSlugs} did. */
export interface SlugBackfillReport {
  /** True when nothing was written — the default. */
  dryRun: boolean;
  fields: SlugBackfillField[];
}

/** One move offered by {@link CollectionClient.transitions}. */
export interface TransitionMove {
  /** The value the row would move to. */
  to: string;
  /** The rule's verb, when it has one — "Mark paid". */
  label?: string;
  allowed: boolean;
  /** Why not, in the same words the write would have been refused with. */
  reason?: string;
  /** `not_allowed` | `forbidden_role` | `missing_fields` | `not_initial`. */
  refusal?: string;
  /** For `missing_fields`: the fields that have to be filled first. */
  missing?: string[];
}

/** The lifecycle state of one field on one row. */
export interface FieldTransitions {
  field: string;
  /** The value the row holds now, or null when it has none yet. */
  current: string | null;
  /** True when no rule leads out of the current value. */
  terminal: boolean;
  moves: TransitionMove[];
}

/** The transport handle `createClient` hands to every domain module. */
export interface ClientCore {
  opts: ClientOptions;
  /** The resolved fetch — `opts.fetch` or the global. */
  fetch: typeof globalThis.fetch;
  /** `/api/auth` or the workspace-scoped `/api/t/<slug>/auth`. */
  authBase: string;
  request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  /** For endpoints whose body/response isn't JSON — bulk export/import, PDF
   *  render. Returns the raw `Response`. */
  requestRaw(method: string, path: string, rawBody?: string, contentType?: string): Promise<Response>;
  collection<T extends Record<string, unknown>>(slug: string): CollectionClient<T>;
  /** App-mode workspace session token, owned by the transport so every
   *  request picks up a sign-in without the auth module holding the header. */
  getToken(): string | null;
  setToken(token: string | null): void;
  /** Called whenever the token actually changes (never on a no-op write).
   *  Returns an unsubscribe. This is what makes `auth.onChange` — and
   *  `useSession` on top of it — see a sign-in that happened anywhere. */
  onTokenChange(fn: (token: string | null) => void): () => void;
  getActiveOrg(): string | null;
  setActiveOrg(org: string | null): void;
  /** Auth + tenant + org headers, for the few calls that build their own
   *  request instead of going through `request` — the TUS upload dance and the
   *  raw storage PUT. Deliberately without `traceparent`: those are the exact
   *  headers the pre-split code sent, and a chunked upload emitting a fresh
   *  trace id per PATCH would bury the run it belongs to. */
  authHeaders(): Record<string, string>;
}
