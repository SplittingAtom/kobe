import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "inventory",
  label: "Inventory",
  description: "The team's skills and connectors; its agents are on the Agents page's Team tab.",
  group: "Agents and skills",
  order: 20,
  permission: "team.agents.suspend",
  // /v1/skills, /v1/team/connectors (KOBE-291); the agents moved to /agents?tab=team (KOBE-570).
  status: READY,
});
