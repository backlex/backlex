-- Opt-in sensitive-read auditing, per collection.
--
-- When `audit_reads` is true, REST read operations on the collection (list +
-- by-id) record an `access.read` row in the `activity` table so admins get a
-- "who viewed this record" trail for regulated data (HIPAA / PCI / gov). Off by
-- default — reads are otherwise never logged, to keep the audit table small.
-- The `access.*` namespace is pruned on its own (shorter) retention; see
-- ACCESS_AUDIT_RETENTION_DAYS in apps/web/src/server/services/scheduler.ts.

ALTER TABLE "collections" ADD COLUMN "audit_reads" boolean DEFAULT false NOT NULL;
