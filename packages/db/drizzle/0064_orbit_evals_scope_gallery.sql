-- Allow scope 'gallery' on orbit_evals (KOBE-94). NOT VALID then VALIDATE: the add takes no long lock.
ALTER TABLE "orbit_evals" DROP CONSTRAINT "orbit_evals_scope";--> statement-breakpoint
ALTER TABLE "orbit_evals" ADD CONSTRAINT "orbit_evals_scope" CHECK ("agent_scope" IN ('team', 'personal', 'gallery')) NOT VALID;--> statement-breakpoint
ALTER TABLE "orbit_evals" VALIDATE CONSTRAINT "orbit_evals_scope";
