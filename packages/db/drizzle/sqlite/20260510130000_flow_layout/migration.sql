-- Flow builder layout metadata. SQLite stores JSON as TEXT; the drizzle
-- column declaration uses { mode: "json" } so it's serialized on write
-- and parsed on read.

ALTER TABLE "flows" ADD COLUMN "layout" text;
