-- PK storage type for managed collections.
--
-- `pk_type` (`uuid` | `text` | `integer`) records what the physical `id`
-- column is. Every pre-existing collection is `uuid` (the only shape the
-- applier ever emitted), hence the default. External-DB migration creates
-- `text` / `integer`-keyed collections so source primary keys can be copied
-- verbatim — preserving PKs is what keeps the source's FK values valid in
-- the target without an id-remap table. Non-uuid integer PKs are never
-- auto-generated; POST requires the key in the body (same contract adopted
-- tables already have).

ALTER TABLE "collections" ADD COLUMN "pk_type" text DEFAULT 'uuid' NOT NULL;
