import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "inventory",
  label: "Inventory",
  description: "Every agent, version, schedule and score in the team, its skills and connectors.",
  group: "Agents and skills",
  order: 20,
  permission: "team.agents.suspend",
  // GET /v1/agents/inventory (KOBE-86), /v1/skills, /v1/team/connectors; the page is KOBE-291.
  status: READY,
});
