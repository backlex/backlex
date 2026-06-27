CREATE TABLE IF NOT EXISTS "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"name" text NOT NULL,
	"description" text,
	"system_prompt" text,
	"model" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_steps" integer DEFAULT 8 NOT NULL,
	"memory" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"agent_id" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"thread_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"tool_name" text,
	"tool_args" jsonb,
	"tool_result" jsonb,
	"tokens_in" integer,
	"tokens_out" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_tenant_name_idx" ON "agents" ("tenant_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_tenant_idx" ON "agents" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_threads_tenant_agent_idx" ON "agent_threads" ("tenant_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_threads_agent_idx" ON "agent_threads" ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_messages_thread_idx" ON "agent_messages" ("thread_id","created_at");
