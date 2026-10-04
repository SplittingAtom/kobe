import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "usage",
  label: "Usage",
  description: "Spend by user, agent and model.",
  group: "Models and spend",
  order: 30,
  // GET /v1/team/usage (KOBE-43).
  permission: "team.budgets.manage",
  status: READY,
});
