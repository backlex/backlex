ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "vectorize" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "vectorize_model" text;
