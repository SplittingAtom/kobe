import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "budgets",
  label: "Budgets",
  description: "Monthly and daily dollar budgets for the team and its members.",
  group: "Workspace settings",
  order: 20,
  // GET /v1/team/budgets (KOBE-42).
  permission: "team.budgets.manage",
  status: READY,
});
