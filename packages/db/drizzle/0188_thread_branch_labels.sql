CREATE TABLE "thread_branch_labels" (
	"team_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"entry_id" text NOT NULL,
	"label" text NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_branch_labels_team_id_thread_id_entry_id_pk" PRIMARY KEY("team_id","thread_id","entry_id"),
	CONSTRAINT "thread_branch_labels_label" CHECK (char_length(btrim("thread_branch_labels"."label")) BETWEEN 1 AND 60 AND "thread_branch_labels"."label" = btrim("thread_branch_labels"."label"))
);
--> statement-breakpoint
ALTER TABLE "thread_branch_labels" ADD CONSTRAINT "thread_branch_labels_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_branch_labels" ADD CONSTRAINT "thread_branch_labels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_branch_labels" ADD CONSTRAINT "thread_branch_labels_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_branch_labels" ADD CONSTRAINT "thread_branch_labels_entry_fk" FOREIGN KEY ("team_id","thread_id","entry_id") REFERENCES "public"."thread_entries"("team_id","thread_id","entry_id") ON DELETE cascade ON UPDATE no action;