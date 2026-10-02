import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "audit",
  label: "Audit view",
  description: "The team's audit events, including break-glass banners.",
  group: "Governance",
  order: 20,
  // GET /v1/team/audit (KOBE-15).
  permission: "team.audit.read",
  status: READY,
});
