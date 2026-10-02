import { comingIn, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "audit",
  label: "Audit view",
  description: "The team's audit events, including break-glass banners.",
  group: "Governance",
  order: 20,
  // No team.audit.read permission exists yet; KOBE-15 should add one and switch to it here.
  permission: "team.members.manage",
  status: comingIn("KOBE-15"),
});
