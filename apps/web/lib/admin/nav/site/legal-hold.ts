import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "legal-hold",
  label: "Legal hold",
  description: "Suspend purges for a team or user (two-person rule).",
  group: "Governance",
  order: 30,
  minRole: "admin",
  status: READY,
});
