-- Flow builder layout metadata.
--
-- Stores the visual graph (nodes + edges + canvas positions) so admins
-- can reopen a flow in the builder without losing their layout. The
-- runtime keeps reading `operations` for execution; `layout` is purely
-- presentational.

ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "layout" jsonb;
