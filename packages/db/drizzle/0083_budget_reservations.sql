CREATE TABLE "budget_reservations" (
	"team_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"usd" numeric(20, 12) DEFAULT 0 NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "budget_reservations_team_id_call_id_pk" PRIMARY KEY("team_id","call_id"),
	CONSTRAINT "budget_reservations_call_id_len" CHECK (char_length("budget_reservations"."call_id") BETWEEN 1 AND 128),
	CONSTRAINT "budget_reservations_amounts" CHECK ("budget_reservations"."usd" >= 0 AND "budget_reservations"."tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "install_budget_reservations" (
	"call_id" text PRIMARY KEY NOT NULL,
	"member_key" text NOT NULL,
	"usd" numeric(20, 12) DEFAULT 0 NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "install_budget_reservations_call_id_len" CHECK (char_length("install_budget_reservations"."call_id") BETWEEN 1 AND 128),
	CONSTRAINT "install_budget_reservations_amounts" CHECK ("install_budget_reservations"."usd" >= 0 AND "install_budget_reservations"."tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_reservations_expiry_idx" ON "budget_reservations" USING btree ("team_id","expires_at");--> statement-breakpoint
CREATE INDEX "install_budget_reservations_expiry_idx" ON "install_budget_reservations" USING btree ("expires_at");