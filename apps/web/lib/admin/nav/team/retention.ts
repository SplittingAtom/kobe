import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "retention",
  label: "Retention",
  description: "How long the team keeps threads, within the install maximum.",
  group: "Governance",
  order: 10,
  permission: "team.retention.manage",
  status: READY,
});
