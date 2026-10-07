CREATE TABLE "run_tokens" (
	"team_id" uuid NOT NULL,
	"jti" text NOT NULL,
	"run_id" uuid NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "run_tokens_team_id_jti_pk" PRIMARY KEY("team_id","jti"),
	CONSTRAINT "run_tokens_jti_len" CHECK (char_length("run_tokens"."jti") BETWEEN 16 AND 128)
);
--> statement-breakpoint
ALTER TABLE "run_tokens" ADD CONSTRAINT "run_tokens_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tokens" ADD CONSTRAINT "run_tokens_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_tokens_run_idx" ON "run_tokens" USING btree ("team_id","run_id");