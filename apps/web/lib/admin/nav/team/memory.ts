import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "memory",
  label: "Memory",
  description: "Let the team's agents remember and recall notes, personal and per project.",
  group: "Agents and skills",
  order: 46,
  permission: "team.memory.manage",
  status: READY,
});
