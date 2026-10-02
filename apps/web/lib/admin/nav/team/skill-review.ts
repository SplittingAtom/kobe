import { comingIn, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "skill-review",
  label: "Skill review",
  description: "Skills waiting for review, with their scan results.",
  group: "Agents and skills",
  order: 30,
  permission: "team.skills.review",
  status: comingIn("KOBE-49"),
});
