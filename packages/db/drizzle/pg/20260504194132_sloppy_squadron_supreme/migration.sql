CREATE TABLE "folders" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"parent_id" text,
	"owner_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "folder_id" text;--> statement-breakpoint
CREATE INDEX "files_folder_idx" ON "files" ("folder_id");--> statement-breakpoint
CREATE INDEX "folders_parent_idx" ON "folders" ("parent_id");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_folders_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL;