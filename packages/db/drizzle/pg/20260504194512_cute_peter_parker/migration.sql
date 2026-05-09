CREATE TABLE "flows" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"operations" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "flows_active_idx" ON "flows" ("active");