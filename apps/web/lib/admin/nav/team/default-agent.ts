import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "default-agent",
  label: "Default agent",
  description: "Choose the agent new conversations start with, from the team's roster.",
  group: "Agents and skills",
  order: 15,
  permission: "team.agents.manage",
  status: READY,
});
