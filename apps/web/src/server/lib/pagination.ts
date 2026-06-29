/**
 * Shared `?limit=&offset=` parsing with a single default + a HARD ceiling.
 *
 * Each list route used to roll its own `Number(c.req.query("limit") ?? N)` —
 * some clamped to a max, some didn't (uploads/webhooks accepted an unbounded
 * limit, a row-count DoS edge). This centralises the clamp so every paginated
 * endpoint shares one safe default and one cap, and NaN/garbage falls back to
 * the default instead of poisoning the query.
 */
type QueryCtx = { req: { query(key: string): string | undefined } };

export interface PaginationOptions {
  /** Limit when `?limit` is absent. Default 50. */
  defaultLimit?: number;
  /** Hard ceiling — `?limit` above this is clamped down. Default 200. */
  maxLimit?: number;
  /** Offset when `?offset` is absent. Default 0. */
  defaultOffset?: number;
}

export interface Pagination {
  limit: number;
  offset: number;
}

/** Parse + clamp `?limit`/`?offset`. `limit ∈ [1, maxLimit]`, `offset ≥ 0`;
 *  non-finite input falls back to the defaults. */
export const parsePagination = (
  c: QueryCtx,
  opts: PaginationOptions = {},
): Pagination => {
  const { defaultLimit = 50, maxLimit = 200, defaultOffset = 0 } = opts;
  const rawLimit = Number(c.req.query("limit") ?? defaultLimit);
  const rawOffset = Number(c.req.query("offset") ?? defaultOffset);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(maxLimit, Math.floor(rawLimit)))
    : defaultLimit;
  const offset = Number.isFinite(rawOffset)
    ? Math.max(0, Math.floor(rawOffset))
    : defaultOffset;
  return { limit, offset };
};
