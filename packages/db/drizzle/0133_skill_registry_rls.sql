-- KOBE-311 (Skills v1.2, SK5–SK8, SK21–SK25): row security, seeds and the system-tag guard for
-- 0132_skill_registry. Custom, so db:rebase keeps this SQL as written. The tables are new and
-- empty, so nothing is backfilled and FORCE RLS needs no lifting.
--
-- Team isolation, as in 0001_team_rls.sql: ENABLE + FORCE RLS and the canonical policy.
ALTER TABLE "team_skill_installs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_installs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_skill_installs"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "team_skill_optouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_optouts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_skill_optouts"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "team_skill_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_skill_blocks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "team_skill_blocks"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "member_skill_enablements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "member_skill_enablements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "member_skill_enablements"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
-- The one Registry settings row (site-wide singleton, like site_model_limits).
INSERT INTO "site_skill_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;--> statement-breakpoint
-- The code-defined system tags (SK5): v1.2 has Default only. The check
-- registry_tags_system_set refuses any other system name; this trigger refuses deleting a system
-- tag, renaming it or changing its kind or status, whoever asks (the owner included).
INSERT INTO "registry_tags" ("name", "kind") VALUES ('default', 'system')
  ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
CREATE FUNCTION public.registry_tags_system_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF OLD.kind = 'system' AND (TG_OP = 'DELETE' OR NEW.name IS DISTINCT FROM OLD.name
      OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'system tags are defined by Kobe and cannot be changed or deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "registry_tags_system_guard" BEFORE UPDATE OR DELETE ON "registry_tags"
  FOR EACH ROW EXECUTE FUNCTION public.registry_tags_system_guard();
