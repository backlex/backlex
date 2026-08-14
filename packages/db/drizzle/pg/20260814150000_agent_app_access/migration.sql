-- An agent an end user is allowed to talk to.
--
-- Agents were built when only operators could reach them, so a workspace's
-- existing ones carry internal prompts and privileged tools. The app-plane chat
-- route must not retroactively hand those to every signed-in end user, so
-- exposure is opt-in PER AGENT and the default is false. A migration that
-- defaulted to true would be a permission change disguised as a schema change.
--
-- Additive with a NOT NULL DEFAULT, so existing rows read as "operators only"
-- and a replay lands in `auto-migrate.ts`'s tolerated "duplicate column" set.

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "app_access" boolean NOT NULL DEFAULT false;
