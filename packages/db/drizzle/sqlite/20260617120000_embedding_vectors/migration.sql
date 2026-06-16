-- Native vector storage for the libSQL / Turso transport.
--
-- The per-model embedding tables are defined in the Drizzle schema but were
-- never materialized by a migration on SQLite — D1 routes vectors to Cloudflare
-- Vectorize, so the metadata-mirror tables were never actually created. This
-- migration creates them (for the first time) WITH the native-vector column so
-- the libSQL transport can store + search vectors in-database.
--
-- `F32_BLOB(<dim>)` is a libSQL fixed-length float32 column (`vector32()` writes
-- it, `vector_distance_cos()` reads it). On plain SQLite (Bun) and D1 the type
-- name carries BLOB affinity, so the table is created without error and simply
-- sits unused on backends that route vectors elsewhere. No libSQL-only DDL
-- (e.g. libsql_vector_idx) lives here, so the migration is safe everywhere.
CREATE TABLE `embeddings_openai_1536` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text DEFAULT 'default' NOT NULL,
	`ref_id` text,
	`content` text,
	`embedding` F32_BLOB(1536),
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `embeddings_openai_1536_namespace_idx` ON `embeddings_openai_1536` (`namespace`);--> statement-breakpoint
CREATE INDEX `embeddings_openai_1536_ref_idx` ON `embeddings_openai_1536` (`ref_id`);--> statement-breakpoint
CREATE TABLE `embeddings_openai_3072` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text DEFAULT 'default' NOT NULL,
	`ref_id` text,
	`content` text,
	`embedding` F32_BLOB(3072),
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `embeddings_openai_3072_namespace_idx` ON `embeddings_openai_3072` (`namespace`);--> statement-breakpoint
CREATE INDEX `embeddings_openai_3072_ref_idx` ON `embeddings_openai_3072` (`ref_id`);--> statement-breakpoint
CREATE TABLE `embeddings_self_host_bge_m3` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text DEFAULT 'default' NOT NULL,
	`ref_id` text,
	`content` text,
	`embedding` F32_BLOB(1024),
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `embeddings_self_host_bge_m3_namespace_idx` ON `embeddings_self_host_bge_m3` (`namespace`);--> statement-breakpoint
CREATE INDEX `embeddings_self_host_bge_m3_ref_idx` ON `embeddings_self_host_bge_m3` (`ref_id`);--> statement-breakpoint
CREATE TABLE `embeddings_bge_m3` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text DEFAULT 'default' NOT NULL,
	`ref_id` text,
	`content` text,
	`embedding` F32_BLOB(1024),
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `embeddings_bge_m3_namespace_idx` ON `embeddings_bge_m3` (`namespace`);--> statement-breakpoint
CREATE INDEX `embeddings_bge_m3_ref_idx` ON `embeddings_bge_m3` (`ref_id`);
