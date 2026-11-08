-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-567 (agents-roster AR9, §6.2): a thread may pin someone else's personal agent that its team
-- runs through a roster. `threads_agent_pin_owner` (0020, renamed in 0091) accepted a personal pin
-- only for the agent's owner. A personal pin is now accepted when (a) the agent's owner is the
-- thread's owner, or (b) the agent has an `active` entry for the thread's team on
-- `team_agent_roster` or an `active` entry on `site_agent_roster`, and it is not bound to another
-- team (`site_agents.bound_team_id` null or the thread's team). A `proposed`, `removed` or
-- (site) `suspended` entry never makes a new pin valid. A bound agent is refused outside its team
-- for its owner too (AR8: it follows its owner into that team only). Team and gallery rules are
-- unchanged.
--
-- The check runs on INSERT and on an UPDATE that changes the pin (agent_scope, agent_id,
-- agent_version) or the thread's owner; any other UPDATE (rename, move, archive) never
-- re-validates, so a pin stays valid after its entry is removed or the agent's owner leaves (D19:
-- threads keep their pins). Before, an UPDATE listing agent_id in SET without changing it
-- re-validated too. A change of agent_version alone is now re-checked as well, builder test
-- threads included (intended: a switch must still be allowed). Invoker rights (the app role reads site_agents and the rosters; the team
-- roster's RLS applies with the thread's team set by withTeam), search_path pinned.
CREATE OR REPLACE FUNCTION "public"."threads_agent_pin_owner"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  pinned_scope text;
  pinned_owner uuid;
  pinned_bound uuid;
BEGIN
  IF NEW.agent_scope IS NULL OR NEW.agent_scope = 'team' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.agent_scope IS NOT DISTINCT FROM OLD.agent_scope
     AND NEW.agent_id IS NOT DISTINCT FROM OLD.agent_id
     AND NEW.agent_version IS NOT DISTINCT FROM OLD.agent_version
     AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id THEN
    RETURN NEW;
  END IF;
  SELECT a.scope::text, a.owner_user_id, a.bound_team_id
    INTO pinned_scope, pinned_owner, pinned_bound
    FROM "public"."site_agents" a WHERE a.id = NEW.agent_id;
  IF NOT FOUND OR pinned_scope <> NEW.agent_scope::text THEN
    RAISE EXCEPTION 'thread pin: agent % is not a % agent available to the thread owner',
      NEW.agent_id, NEW.agent_scope USING ERRCODE = '23514';
  END IF;
  -- A bound agent (AR8) is pinned in its team only, by its owner as by anyone else.
  IF pinned_scope = 'personal' AND pinned_bound IS NOT NULL AND pinned_bound <> NEW.team_id THEN
    RAISE EXCEPTION 'thread pin: agent % is not a % agent available to the thread owner',
      NEW.agent_id, NEW.agent_scope USING ERRCODE = '23514';
  END IF;
  IF pinned_scope = 'personal'
     AND pinned_owner IS DISTINCT FROM NEW.owner_user_id
     AND NOT EXISTS (SELECT 1 FROM "public"."team_agent_roster" r
                      WHERE r.team_id = NEW.team_id AND r.site_agent_id = NEW.agent_id
                        AND r.state = 'active')
     AND NOT EXISTS (SELECT 1 FROM "public"."site_agent_roster" s
                      WHERE s.site_agent_id = NEW.agent_id AND s.state = 'active') THEN
    RAISE EXCEPTION 'thread pin: agent % is not a % agent available to the thread owner',
      NEW.agent_id, NEW.agent_scope USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER "threads_agent_pin_owner" ON "threads";--> statement-breakpoint
CREATE TRIGGER "threads_agent_pin_owner"
  BEFORE INSERT OR UPDATE OF "agent_scope", "agent_id", "agent_version", "owner_user_id" ON "threads"
  FOR EACH ROW EXECUTE FUNCTION "public"."threads_agent_pin_owner"();
