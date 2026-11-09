import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "egress",
  label: "Egress",
  description: "Enable domains within the site ceiling, answer access requests, inject headers.",
  group: "Workspace settings",
  order: 40,
  permission: "team.egress.manage",
  status: READY,
});
