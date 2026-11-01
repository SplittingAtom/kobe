CREATE TABLE "thread_folders" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_folders_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "thread_folders_name" CHECK (char_length(btrim("thread_folders"."name")) BETWEEN 1 AND 80 AND "thread_folders"."name" = btrim("thread_folders"."name"))
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "thread_folders" ADD CONSTRAINT "thread_folders_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_folders" ADD CONSTRAINT "thread_folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_folders" ADD CONSTRAINT "thread_folders_parent_fk" FOREIGN KEY ("team_id","parent_id") REFERENCES "public"."thread_folders"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_folders_tree_idx" ON "thread_folders" USING btree ("team_id","parent_id","position","name");