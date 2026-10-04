import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "agents",
  label: "Team agents",
  description: "The team's agents: build and publish them; admins can also suspend them.",
  group: "Agents and skills",
  order: 10,
  permission: "team.agents.build",
  status: READY,
});
