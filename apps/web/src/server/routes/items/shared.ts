import type { Context } from "hono";
import type { AppBindings } from "../../app";
import { elapsedMs, keepAlive, requestMeta } from "../../services/activity";
import { recordSensitiveRead } from "../../services/items/read-audit";
import type { CollectionRow } from "../../services/items/collection-loader";

/**
 * Fire-and-forget sensitive-read audit, for the REST surface.
 *
 * A thin adapter over `services/items/read-audit.ts::recordSensitiveRead` —
 * this function's whole job is to turn a Hono `Context` into the four values
 * that service needs. The rules (opt-in gate, metadata only, never awaited)
 * live there, because GraphQL has no `Context` and used to write no audit rows
 * at all as a result. A second implementation for the second surface is exactly
 * how the two drift; the WRITE path already shares one chokepoint and the read
 * path now does too.
 *
 * Runs inside `keepAlive` (waitUntil) so reads take zero added latency. The
 * `access.` prefix keeps these rows on their own Logs lens + shorter retention
 * (see ACCESS_AUDIT_RETENTION_DAYS in services/scheduler.ts).
 */
export const auditRead = (
  c: Context<AppBindings>,
  collection: CollectionRow,
  itemId: string | null,
  payload: Record<string, unknown>,
): void => {
  const ctx = c.get("ctx");
  const auth = c.get("auth");
  keepAlive(
    c,
    recordSensitiveRead({ db: ctx.db, dialect: ctx.dialect }, collection, {
      userId: auth.userId,
      tenantId: auth.tenantId ?? null,
      itemId,
      payload,
      ...requestMeta(c.req.raw),
      durationMs: elapsedMs(c),
    }),
  );
};

/**
 * The collection-level sub-paths that only answer POST, mapped to what they are.
 *
 * `/api/items/{slug}/{id}` matches literally any second segment, so a GET of a
 * POST-only sub-path is routed to the by-id handler with `id: "search"`, finds
 * no such row, and answers `404 Item not found` — a sentence about a missing
 * ROW, when the truth is that the path exists and takes a different verb. It
 * sends the reader looking for the item.
 *
 * Two of this session's "findings" were exactly that message believed. Both
 * were withdrawn, but only after the endpoints were re-read; a caller without
 * the source has nothing to re-read.
 *
 * Keep in step with the `path: "/{slug}/…"` registrations in this directory.
 * `export` and `changes` are deliberately absent — they answer GET, so they
 * never fall through to here.
 */
export const POST_ONLY_SUBPATHS: Readonly<Record<string, string>> = {
  aggregate: "count / sum / avg / min / max over the collection",
  search: "full-text, vector or hybrid ranking",
  batch: "mixed create / update / delete in one request",
  "bulk-update": "one patch applied to every row a filter matches",
  import: "CSV or JSON rows in",
  ingest: "schema-on-read ingest",
  reorder: "move a row within a manually ordered list",
};

/**
 * The message for a by-id lookup that found nothing.
 *
 * Identical for every real miss — a caller must not be able to tell a row that
 * does not exist from one they cannot read. The only case that says anything
 * else is an id that is not an id at all but the name of a sibling endpoint,
 * where no row was ever in question.
 */
export const itemNotFoundMessage = (id: string): string => {
  // `Object.hasOwn`, not a plain lookup: `POST_ONLY_SUBPATHS["constructor"]`
  // finds `Object` on the prototype chain and is truthy, so a bare index would
  // answer `GET …/constructor` with a message naming a native function — and
  // would make three ids (`constructor`, `toString`, `valueOf`) behave unlike
  // every other miss, which is the seam this message must not have.
  if (!Object.hasOwn(POST_ONLY_SUBPATHS, id)) return "Item not found";
  const what = POST_ONLY_SUBPATHS[id];
  return `"${id}" is not an item id — it is a POST endpoint on this collection (${what}). Send POST /api/items/{slug}/${id} with a JSON body.`;
};
