/**
 * One canonical rendering of a tool call's arguments, so two calls are "the
 * same call" exactly when they would do the same thing.
 *
 * ## What this replaces, and why it was wrong
 *
 * Both the approval gate and the runner's per-turn duplicate guard used to key
 * on `JSON.stringify(args, Object.keys(args).sort())`. The second argument to
 * `JSON.stringify` is a REPLACER ARRAY, and a replacer array filters properties
 * at every level of the tree — not just the top. So every nested object was
 * serialised as `{}`:
 *
 *   {collection:"orders", operations:[{op:"create", data:{title:"x"}}]}
 *   {collection:"orders", operations:[{op:"delete", id:"any-row"}]}
 *     -> both {"collection":"orders","operations":[{}]}
 *
 * Approving the first therefore approved the second: same thread, same tool,
 * byte-identical fingerprint. Every tool whose payload lives one level down —
 * `collections.batch`, `bulk_update`, anything with a `data` object — was
 * covered by an approval a person granted for a different operation. In the
 * runner the same collision reads the other way: two genuinely different calls
 * in one turn look like a repeat, and the second is refused as a duplicate.
 *
 * Sorting keys is still the point — argument order must not make one call look
 * like two — it just has to happen at every level, which a replacer array
 * cannot do.
 */

/**
 * Deterministic JSON: object keys sorted at every depth, arrays left in order
 * (an array's order is part of its meaning), `undefined` dropped the way
 * `JSON.stringify` already drops it.
 *
 * Cycles are impossible in practice — arguments arrive as parsed JSON from the
 * model — but a cycle here would be an unbounded recursion on a security path,
 * so one is rendered as `"[circular]"` rather than thrown.
 */
export const stableStringify = (value: unknown): string => {
  const seen = new Set<object>();
  const walk = (v: unknown): string => {
    if (v === null) return "null";
    if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
    if (typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v !== "object") return "null"; // undefined, function, symbol
    if (seen.has(v as object)) return '"[circular]"';
    seen.add(v as object);
    try {
      if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => val !== undefined && typeof val !== "function")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${walk(val)}`).join(",")}}`;
    } finally {
      seen.delete(v as object);
    }
  };
  return walk(value);
};

/**
 * A bounded digest of the canonical form.
 *
 * Bounded matters: the fingerprint is stored in `approval_requests.subject_id`,
 * which is indexed. Postgres refuses a btree entry over ~2704 bytes, so a
 * canonical form written straight into that column would make a large-payload
 * tool call throw on Postgres while working on SQLite — a dialect-divergent
 * failure introduced by the fix itself. The old code never hit it only because
 * it was dropping the nested values that make a payload large.
 */
export const argsDigest = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};
