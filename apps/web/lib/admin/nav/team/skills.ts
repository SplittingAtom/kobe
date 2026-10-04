import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "skills",
  label: "Skills",
  description: "Create and edit skills in the browser; each save is a new version.",
  group: "Agents and skills",
  order: 20,
  permission: "team.skills.publish",
  status: READY,
});
