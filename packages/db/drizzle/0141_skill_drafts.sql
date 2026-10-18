CREATE TABLE "skill_draft_files" (
	"team_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"path" text NOT NULL,
	"text_content" text,
	"bytes" "bytea",
	"size" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_draft_files_team_id_draft_id_path_pk" PRIMARY KEY("team_id","draft_id","path"),
	CONSTRAINT "skill_draft_files_path_size" CHECK (octet_length("skill_draft_files"."path") BETWEEN 1 AND 240),
	CONSTRAINT "skill_draft_files_one_content" CHECK (("skill_draft_files"."text_content" IS NULL) <> ("skill_draft_files"."bytes" IS NULL)),
	CONSTRAINT "skill_draft_files_size" CHECK ("skill_draft_files"."size" = COALESCE(octet_length("skill_draft_files"."text_content"), octet_length("skill_draft_files"."bytes")) AND "skill_draft_files"."size" <= 5242880)
);
--> statement-breakpoint
CREATE TABLE "skill_drafts" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"started_from" text DEFAULT 'blank' NOT NULL,
	"parent_ref" jsonb,
	"from_thread_id" uuid,
	"rev" integer DEFAULT 1 NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "skill_drafts_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "skill_drafts_name_format" CHECK ("skill_drafts"."name" ~ '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'),
	CONSTRAINT "skill_drafts_started_from" CHECK ("skill_drafts"."started_from" IN ('blank', 'template', 'thread', 'fork', 'upload', 'git')),
	CONSTRAINT "skill_drafts_parent_ref" CHECK ("skill_drafts"."parent_ref" IS NULL OR (jsonb_typeof("skill_drafts"."parent_ref") = 'object' AND octet_length("skill_drafts"."parent_ref"::text) <= 4096)),
	CONSTRAINT "skill_drafts_rev_positive" CHECK ("skill_drafts"."rev" > 0),
	CONSTRAINT "skill_drafts_size" CHECK ("skill_drafts"."size_bytes" BETWEEN 0 AND 5242880 AND "skill_drafts"."file_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "skill_draft_files" ADD CONSTRAINT "skill_draft_files_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_draft_files" ADD CONSTRAINT "skill_draft_files_draft_fk" FOREIGN KEY ("team_id","draft_id") REFERENCES "public"."skill_drafts"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD CONSTRAINT "skill_drafts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD CONSTRAINT "skill_drafts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_drafts" ADD CONSTRAINT "skill_drafts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_drafts_owner_idx" ON "skill_drafts" USING btree ("team_id","owner_user_id","updated_at");--> statement-breakpoint
CREATE INDEX "skill_drafts_updated_idx" ON "skill_drafts" USING btree ("team_id","updated_at");