-- Team agent chat — SQLite/D1 twin of the pg migration. See it for the why.

ALTER TABLE `agent_messages` ADD COLUMN `user_id` text;
