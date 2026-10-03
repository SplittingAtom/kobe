CREATE TYPE "public"."sandbox_state" AS ENUM('running', 'hibernated', 'destroyed');--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sandbox_id" uuid,
	"state" "sandbox_state" DEFAULT 'running' NOT NULL,
	"pvc" text,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retain_until" timestamp with time zone,
	CONSTRAINT "sandboxes_team_id_user_id_pk" PRIMARY KEY("team_id","user_id"),
	CONSTRAINT "sandboxes_pvc" CHECK ("sandboxes"."pvc" IS NULL OR char_length("sandboxes"."pvc") BETWEEN 1 AND 253),
	CONSTRAINT "sandboxes_retain_until" CHECK ("sandboxes"."retain_until" IS NULL OR "sandboxes"."state" = 'destroyed')
);
--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandboxes_awake_idx" ON "sandboxes" USING btree ("team_id","last_active_at") WHERE "sandboxes"."state" = 'running';