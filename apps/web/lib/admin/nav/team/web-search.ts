import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "web-search",
  label: "Web search",
  description: "Let the team's agents search the web through the install's provider.",
  group: "Agents and skills",
  order: 45,
  permission: "team.connectors.manage",
  status: READY,
});
