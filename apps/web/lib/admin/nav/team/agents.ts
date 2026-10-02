import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "agents",
  label: "Team agents",
  description: "The team's agents and their status; suspend or reactivate them.",
  group: "Agents and skills",
  order: 10,
  permission: "team.agents.suspend",
  status: READY,
});
