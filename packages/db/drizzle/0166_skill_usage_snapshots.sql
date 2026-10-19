CREATE TABLE "skill_usage_snapshots" (
	"window_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "skill_usage_snapshots_window" CHECK ("skill_usage_snapshots"."window_start" < "skill_usage_snapshots"."window_end")
);
