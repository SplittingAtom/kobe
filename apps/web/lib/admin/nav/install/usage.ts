import { READY, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "usage",
  label: "Usage and spend",
  description: "Spend by team, user, agent and model against the site budget.",
  group: "Governance",
  order: 50,
  // GET /v1/site/usage (install.usage.read, KOBE-43).
  minRole: "admin",
  status: READY,
});
