CREATE TABLE "workspace_moves" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rev" bigint NOT NULL,
	"from_path" text NOT NULL,
	"to_path" text NOT NULL,
	"type" text NOT NULL,
	"files" integer NOT NULL,
	"bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_moves_team_id_user_id_rev_pk" PRIMARY KEY("team_id","user_id","rev"),
	CONSTRAINT "workspace_moves_paths" CHECK (octet_length("workspace_moves"."from_path") BETWEEN 1 AND 1024 AND octet_length("workspace_moves"."to_path") BETWEEN 1 AND 1024),
	CONSTRAINT "workspace_moves_type" CHECK ("workspace_moves"."type" IN ('file', 'dir')),
	CONSTRAINT "workspace_moves_numbers" CHECK ("workspace_moves"."rev" > 0 AND "workspace_moves"."files" > 0 AND "workspace_moves"."bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "workspace_moves" ADD CONSTRAINT "workspace_moves_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_moves" ADD CONSTRAINT "workspace_moves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;