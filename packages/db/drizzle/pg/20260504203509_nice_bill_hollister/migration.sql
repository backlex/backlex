CREATE TABLE "functions" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"pattern" text,
	"code" text NOT NULL,
	"timeout_ms" integer DEFAULT 5000 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "functions_name_idx" ON "functions" ("name");--> statement-breakpoint
CREATE INDEX "functions_trigger_idx" ON "functions" ("trigger","active");