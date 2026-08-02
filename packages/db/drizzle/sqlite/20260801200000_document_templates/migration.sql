-- Document templates — the HTML a contract, quote or invoice is rendered from.
-- SQLite/D1 twin of the pg migration.
--
-- `body_html` is a COMPLETE document rather than a fragment: a contract sets
-- its own fonts, page size and print styles, and a wrapper would fight that.
-- `page_options` holds the PdfPageOptions blob (format, margins, landscape),
-- which is per-template because an invoice and a shipping label are not the
-- same shape of paper.
CREATE TABLE IF NOT EXISTS `document_templates` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text,
  `key` text NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `body_html` text NOT NULL,
  `header_html` text,
  `footer_html` text,
  `page_options` text,
  `filename` text,
  `variables` text,
  `updated_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
-- One key per workspace. A NULL tenant_id is the instance-wide default that a
-- workspace row overrides, matching how email_templates resolve.
CREATE UNIQUE INDEX IF NOT EXISTS `document_templates_tenant_key_idx`
  ON `document_templates` (`tenant_id`, `key`);
