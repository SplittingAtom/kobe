-- KOBE-495: a Site admin publishes a catalog version as publisher `site` on any catalog skill
-- (Kobe's or a maintainer's), so a version's publisher is no longer always its skill's. The foreign
-- key registry_versions_publisher_fk (skill_id, publisher) -> registry_skills (id, publisher),
-- dropped in 0178, is replaced by this trigger: every other version still names its skill with
-- the skill's own publisher (Kobe never publishes a maintainer's skill, nobody submits Kobe's),
-- and a skill's publisher can't move away from its versions'. Errors keep the foreign key's
-- SQLSTATE and constraint name, and come after the row's CHECKs as the key's did (AFTER
-- triggers). `::text` comparisons: 'site' is new in this transaction. Custom, so db:rebase keeps
-- this SQL as written. Invoker rights, pinned search_path.
CREATE FUNCTION public.registry_versions_publisher_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.publisher::text <> 'site' AND NOT EXISTS (
      SELECT 1 FROM "public"."registry_skills" s
       WHERE s.id = NEW.skill_id AND s.publisher = NEW.publisher
       FOR KEY SHARE) THEN
    RAISE EXCEPTION 'a catalog version''s publisher must be its skill''s, or the Site'
      USING ERRCODE = '23503', CONSTRAINT = 'registry_versions_publisher_fk';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "registry_versions_publisher_guard" AFTER INSERT OR UPDATE OF "skill_id", "publisher"
  ON "registry_versions"
  FOR EACH ROW EXECUTE FUNCTION public.registry_versions_publisher_guard();--> statement-breakpoint
CREATE FUNCTION public.registry_skills_publisher_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.publisher IS DISTINCT FROM OLD.publisher AND EXISTS (
      SELECT 1 FROM "public"."registry_versions" v
       WHERE v.skill_id = OLD.id AND v.publisher::text <> 'site') THEN
    RAISE EXCEPTION 'a catalog skill''s publisher is its versions'''
      USING ERRCODE = '23503', CONSTRAINT = 'registry_versions_publisher_fk';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
CREATE TRIGGER "registry_skills_publisher_guard" AFTER UPDATE OF "publisher" ON "registry_skills"
  FOR EACH ROW EXECUTE FUNCTION public.registry_skills_publisher_guard();
