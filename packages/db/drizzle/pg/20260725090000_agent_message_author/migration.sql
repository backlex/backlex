-- Team agent chat: attribute each `user` message to the team member who wrote
-- it. Agent threads are already tenant-wide (anyone on the team can open one),
-- so a transcript without an author reads as if one person asked everything.

ALTER TABLE "agent_messages" ADD COLUMN IF NOT EXISTS "user_id" text;
