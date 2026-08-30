-- Reusable procedural knowledge an agent can consult.
--
-- An agent already had a `system_prompt`, but a prompt belongs to one agent and
-- is paid for on every turn. A skill belongs to the workspace, attaches to
-- several agents, and only its name and description reach the prompt — the body
-- is fetched when the model decides it needs it, so a long reference costs
-- nothing until it is wanted.
--
-- The columns are the open Agent Skills shape (name + description + markdown
-- body) on purpose: a tenant can paste a `SKILL.md` written for any other agent
-- tool and have it work here. Inventing a different shape would have thrown
-- that interoperability away, which is the only reason to build this rather
-- than a second prompt field.
--
-- `agents.skills` holds the names an agent may consult, defaulting to empty, so
-- every agent that exists today is unchanged.
--
-- Replayable: `IF NOT EXISTS` throughout, because the boot-time runner
-- re-applies every migration file on every start.

CREATE TABLE IF NOT EXISTS "agent_skills" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "body" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_skills_tenant_idx" ON "agent_skills" ("tenant_id");--> statement-breakpoint
-- The model addresses a skill by name, so the name has to be unambiguous
-- inside a workspace.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_skills_tenant_name_idx" ON "agent_skills" ("tenant_id","name");--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "skills" jsonb NOT NULL DEFAULT '[]'::jsonb;
