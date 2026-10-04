import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "egress",
  label: "Egress",
  description: "Enable domains within the install ceiling, answer access requests, inject headers.",
  group: "Access",
  order: 20,
  permission: "team.egress.manage",
  status: READY,
});
