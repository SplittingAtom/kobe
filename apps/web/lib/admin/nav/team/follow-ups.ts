import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "follow-ups",
  label: "Follow-ups",
  description: "Suggest three follow-up messages after each answer (a short model call per run).",
  group: "Models and spend",
  order: 15,
  permission: "team.models.manage",
  status: READY,
});
