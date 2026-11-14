import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "memory",
  label: "Memory",
  description:
    "Site memories and Policy for every workspace: edit, import and export (Site admins and Site memory stewards).",
  group: "Governance",
  order: 45,
  minRole: "admin",
  grant: "memory_steward",
  status: READY,
});
