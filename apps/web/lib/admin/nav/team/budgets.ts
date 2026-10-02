import { comingIn, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "budgets",
  label: "Budgets",
  description: "Monthly and daily dollar budgets for the team and its members.",
  group: "Models and spend",
  order: 20,
  permission: "team.budgets.manage",
  status: comingIn("KOBE-42"),
});
