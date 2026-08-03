-- Sequence fields: a document number the server issues (INV-2026-0001).
--
-- Seventeen of the twenty-seven schema templates declare a `required + unique`
-- document number, and until now every one of them had to be invented by the
-- caller: `onCreate` could mint a uuid, a timestamp, a user id or a tenant id,
-- and nothing that counts. The usual client-side workaround is "read the
-- highest, add one", which two concurrent creates both compute from the same
-- snapshot. On a collection with the unique index that is a failed insert; on
-- one without it, two invoices quietly share a number.
--
-- Only the counter needs storage. The pattern, the padding and the reset period
-- are field metadata inside `collections.fields`, like a rollup spec — so this
-- migration adds one table and nothing else.
--
-- The allocation is a single statement:
--
--   INSERT INTO sequences (…, last_value) VALUES (…, :start + :n - 1)
--   ON CONFLICT (tenant_id, collection, field, scope)
--   DO UPDATE SET last_value = sequences.last_value + :n
--   RETURNING last_value;
--
-- One statement, evaluated by the database, so two concurrent allocations
-- cannot read the same "before" value and both claim it. Both branches return
-- the LAST number of the block, so a bulk insert of n rows takes the range
-- [returned - n + 1, returned] in one round trip rather than n.
--
-- What this deliberately does NOT provide is a gap-free series. The counter is
-- bumped outside whatever transaction the row write is in — exactly like a
-- Postgres SEQUENCE — so a number requested by an insert that then fails
-- validation, or by an atomic batch that rolls back, is spent. Closing that
-- would mean holding the counter row locked for the duration of every insert,
-- serialising all writes to the collection. Gapless statutory invoice
-- numbering is a bookkeeping process, not a database default.
CREATE TABLE IF NOT EXISTS "sequences" (
  "id" text PRIMARY KEY NOT NULL,
  -- NOT NULL with '' for "no tenant", unlike every neighbouring table.
  --
  -- A unique index treats NULLs as DISTINCT in both dialects. If this column
  -- were nullable, an install with no tenant could hold two counter rows for
  -- the same field: the ON CONFLICT below would stop matching, every insert
  -- would create a fresh row starting over, and every document would come out
  -- with the same number. The sentinel is what makes the key a key.
  "tenant_id" text DEFAULT '' NOT NULL,
  "collection" text NOT NULL,
  "field" text NOT NULL,
  -- The reset bucket: '' for `never`, else the calendar period ('2026',
  -- '2026-08', '2026-08-03') resolved in the spec's own time zone.
  --
  -- Nothing resets the counter on a schedule. A yearly sequence asks for the
  -- bucket named '2027', finds no row, and starts at `start` — so there is no
  -- midnight job that can fail to run, and no window in which two years share
  -- a counter.
  "scope" text DEFAULT '' NOT NULL,
  -- The last counter handed out; the next allocation returns this + n.
  "last_value" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The ON CONFLICT target. Also the thing that makes concurrent allocation
-- correct: without it the upsert has nothing to conflict on and degrades to a
-- plain insert.
CREATE UNIQUE INDEX IF NOT EXISTS "sequences_key_idx"
  ON "sequences" ("tenant_id", "collection", "field", "scope");
