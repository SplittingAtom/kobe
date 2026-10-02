import { comingIn, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "legal-hold",
  label: "Legal hold",
  description: "Suspend purges for a team or user (two-person rule).",
  group: "Governance",
  order: 30,
  minRole: "admin",
  status: comingIn("KOBE-17"),
});
