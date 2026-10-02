import { comingIn, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "usage",
  label: "Usage and spend",
  description: "Spend by team, user, agent and model against the install budget.",
  group: "Governance",
  order: 50,
  minRole: "admin",
  status: comingIn("KOBE-43"),
});
