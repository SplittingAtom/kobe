import { TEAM_TAB_HREF } from "../../../agents/redirects";
import { defineTeamSection, movedTo } from "../types";

export default defineTeamSection({
  id: "agents",
  label: "Team agents",
  description:
    "The team's roster on the Agents page: build, assign and approve agents; admins see usage, schedules and scores and suspend them.",
  group: "Agents and skills",
  order: 10,
  permission: "team.agents.build",
  // The list and the Inventory moved to /agents?tab=team (KOBE-570, AR12); the builder stays here.
  status: movedTo(TEAM_TAB_HREF),
});
