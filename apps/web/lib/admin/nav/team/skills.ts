import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "skills",
  label: "Skills",
  description:
    "Team skills: access modes, the agents they reach, catalog installs. Skills are written in the Workbench.",
  group: "Agents and skills",
  order: 20,
  permission: "team.skills.publish",
  status: READY,
});
