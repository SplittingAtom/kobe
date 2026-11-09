import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "usage",
  label: "Usage",
  description: "Spend by user, agent and model.",
  group: "Governance",
  order: 5,
  // GET /v1/team/usage (KOBE-43).
  permission: "team.budgets.manage",
  status: READY,
});
