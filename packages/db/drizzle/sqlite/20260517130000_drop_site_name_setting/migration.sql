-- The instance-wide "site name" used to live in app_settings.key = 'siteName'
-- but never rendered anywhere — workspace_config.workspace_name is the real
-- display name (drives the sidebar title and document.title). Drop the orphan
-- rows so admins don't see a write that does nothing.

DELETE FROM `app_settings` WHERE `key` = 'siteName';
