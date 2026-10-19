ALTER TABLE "teams" ADD COLUMN "registry" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "teams_registry_uq" ON "teams" USING btree ("registry") WHERE "teams"."registry";