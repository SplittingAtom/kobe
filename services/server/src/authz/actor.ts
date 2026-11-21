import type { Context } from "hono";
import type { ActorContext } from "@kobe/protocol";
import type { TeamVariables } from "./middleware.js";

/** The verified caller (session + active team), never taken from the request body. */
export function actorOf(c: Context<{ Variables: TeamVariables }>): ActorContext {
  const team = c.get("team");
  return {
    user_id: c.get("user").id,
    team_id: team.id,
    site_role: c.get("siteRole") ?? "user",
    team_role: team.role,
  };
}
