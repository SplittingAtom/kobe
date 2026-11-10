CREATE TABLE "thread_file_links" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"project_id" uuid,
	"path" text NOT NULL,
	"access" text NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "thread_file_links_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "thread_file_links_key" UNIQUE NULLS NOT DISTINCT("team_id","thread_id","owner_user_id","project_id","path","access"),
	CONSTRAINT "thread_file_links_scope" CHECK (("thread_file_links"."owner_user_id" IS NULL) <> ("thread_file_links"."project_id" IS NULL)),
	CONSTRAINT "thread_file_links_path" CHECK (octet_length("thread_file_links"."path") BETWEEN 1 AND 1024 AND "thread_file_links"."path" !~ '(^/|/$|//)'),
	CONSTRAINT "thread_file_links_access" CHECK ("thread_file_links"."access" IN ('read', 'write')),
	CONSTRAINT "thread_file_links_count" CHECK ("thread_file_links"."count" > 0 AND "thread_file_links"."last_at" >= "thread_file_links"."first_at")
);
--> statement-breakpoint
ALTER TABLE "thread_file_links" ADD CONSTRAINT "thread_file_links_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_file_links" ADD CONSTRAINT "thread_file_links_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_file_links" ADD CONSTRAINT "thread_file_links_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_file_links" ADD CONSTRAINT "thread_file_links_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_file_links_owner_path_idx" ON "thread_file_links" USING btree ("team_id","owner_user_id","path") WHERE "thread_file_links"."owner_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "thread_file_links_project_path_idx" ON "thread_file_links" USING btree ("team_id","project_id","path") WHERE "thread_file_links"."project_id" IS NOT NULL;