import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "break-glass",
  label: "Break-glass access",
  description: "Install admins' read-only break-glass access to this team: active now and history.",
  group: "Governance",
  order: 25,
  // GET /v1/team/break-glass (KOBE-16).
  permission: "team.audit.read",
  status: READY,
});
