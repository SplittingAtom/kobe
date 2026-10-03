import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "egress",
  label: "Egress",
  description: "Enable domains within the install ceiling (access requests: KOBE-39).",
  group: "Access",
  order: 20,
  permission: "team.egress.manage",
  status: READY,
});
