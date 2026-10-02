import { comingIn, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "usage",
  label: "Usage",
  description: "Spend by user, agent and model.",
  group: "Models and spend",
  order: 30,
  permission: "team.budgets.manage",
  status: comingIn("KOBE-43"),
});
