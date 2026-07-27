-- Episodic/semantic split for agent memory.
--
-- Agent memory used to be one undifferentiated pile of embedded transcript
-- snippets. That conflates two things with opposite lifecycles: raw turns
-- (many, disposable, only useful inside their own conversation) and durable
-- facts (few, long-lived, worth reading and correcting). The turns stay
-- vector-only; the facts land here as real rows so they can be listed,
-- corrected, and forgotten — none of which the vector adapter contract can do.
--
-- `agents.memory_scope` defaults to 'thread', which is exactly the behaviour
-- agents had before this migration: nothing learned in one conversation can
-- surface in another unless an operator opts in.

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "memory_scope" text DEFAULT 'thread' NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_memories" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "agent_id" text NOT NULL,
  "thread_id" text,
  "scope" text DEFAULT 'thread' NOT NULL,
  "content" text NOT NULL,
  "embedded" boolean DEFAULT false NOT NULL,
  "hits" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_agent_idx" ON "agent_memories" ("agent_id","scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_thread_idx" ON "agent_memories" ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_tenant_idx" ON "agent_memories" ("tenant_id");
