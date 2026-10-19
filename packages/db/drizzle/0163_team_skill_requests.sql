CREATE TABLE "team_skill_requests" (
	"team_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "team_skill_requests_team_id_skill_id_user_id_pk" PRIMARY KEY("team_id","skill_id","user_id"),
	CONSTRAINT "team_skill_requests_order" CHECK ("team_skill_requests"."first_at" <= "team_skill_requests"."last_at")
);
--> statement-breakpoint
ALTER TABLE "team_skill_requests" ADD CONSTRAINT "team_skill_requests_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_requests" ADD CONSTRAINT "team_skill_requests_skill_id_registry_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."registry_skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_requests" ADD CONSTRAINT "team_skill_requests_member_fk" FOREIGN KEY ("team_id","user_id") REFERENCES "public"."team_members"("team_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_skill_requests_open_idx" ON "team_skill_requests" USING btree ("team_id","last_at" DESC NULLS LAST) WHERE "team_skill_requests"."dismissed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "team_skill_requests_member_idx" ON "team_skill_requests" USING btree ("team_id","user_id","last_at");