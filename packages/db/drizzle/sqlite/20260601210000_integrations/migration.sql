-- Third-party integrations (Slack/Discord/Datadog/GitHub) connected per
-- workspace. Mirror of the PG table; `config` secret fields are encrypted at
-- rest, `events` NULL = all events.
CREATE TABLE integrations (
	id text PRIMARY KEY NOT NULL,
	tenant_id text,
	kind text NOT NULL,
	config text DEFAULT '{}' NOT NULL,
	events text,
	status text DEFAULT 'connected' NOT NULL,
	last_event_at integer,
	created_at integer NOT NULL,
	updated_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX integrations_tenant_idx ON integrations (tenant_id);
