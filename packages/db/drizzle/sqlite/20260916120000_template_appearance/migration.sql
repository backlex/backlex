-- See packages/db/drizzle/pg/20260916120000_template_appearance/migration.sql for the rationale;
-- this is the SQLite/D1 twin. JSON is stored as text.

ALTER TABLE `email_templates` ADD COLUMN `appearance` text;
--> statement-breakpoint
ALTER TABLE `document_templates` ADD COLUMN `appearance` text;
