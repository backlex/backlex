-- E-signature — a rendered document, the people who have to sign it, and the
-- evidence that they did.
--
-- `body_html` is a SNAPSHOT of the interpolated document taken when the
-- request was sent, not a pointer back at the template it came from. A
-- template edited next week must not change what somebody signed last week,
-- and the row the document describes moves on too.
--
-- `document_hash` therefore hashes that snapshot rather than the PDF bytes:
-- two renders of one document are not byte-identical across renderer versions,
-- so a PDF hash would fail a re-verification that is actually fine.
CREATE TABLE IF NOT EXISTS "signature_requests" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text,
  "title" text NOT NULL,
  "message" text,
  "template_key" text,
  "body_html" text NOT NULL,
  "page_options" jsonb,
  "filename" text,
  "document_hash" text NOT NULL,
  "document_key" text,
  "signed_document_key" text,
  "signed_document_hash" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "ordered" boolean DEFAULT false NOT NULL,
  "expires_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "voided_at" timestamp with time zone,
  "void_reason" text,
  "write_back" jsonb,
  "notify_emails" jsonb,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signature_requests_tenant_idx"
  ON "signature_requests" ("tenant_id");
--> statement-breakpoint
-- The admin list is "this workspace's outstanding requests", so status rides
-- along with the tenant rather than being indexed on its own.
CREATE INDEX IF NOT EXISTS "signature_requests_status_idx"
  ON "signature_requests" ("tenant_id", "status");
--> statement-breakpoint
-- One row per signer: a rental agreement has a tenant AND a landlord, and each
-- needs their own link, their own consent and their own timestamp.
CREATE TABLE IF NOT EXISTS "signature_signers" (
  "id" text PRIMARY KEY NOT NULL,
  "request_id" text NOT NULL,
  "email" text NOT NULL,
  "name" text,
  "role" text,
  "order_index" integer DEFAULT 0 NOT NULL,
  "token_hash" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "sent_at" timestamp with time zone,
  "viewed_at" timestamp with time zone,
  "signed_at" timestamp with time zone,
  "declined_at" timestamp with time zone,
  "decline_reason" text,
  "signature_kind" text,
  "signature_image" text,
  "signature_text" text,
  "consent_text" text,
  "ip" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Only the SHA-256 of the link token is stored. The token is shown once, in
-- the invitation email; a readable one here would let anyone with database
-- access sign as the customer.
CREATE UNIQUE INDEX IF NOT EXISTS "signature_signers_token_idx"
  ON "signature_signers" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signature_signers_request_idx"
  ON "signature_signers" ("request_id", "order_index");
