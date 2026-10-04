import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "skill-review",
  label: "Skill review",
  description: "Approve or reject scanned skill versions; switch personal skills off for the team.",
  group: "Agents and skills",
  order: 30,
  permission: "team.skills.review",
  status: READY,
});
