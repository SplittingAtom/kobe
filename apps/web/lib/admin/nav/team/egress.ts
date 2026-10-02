import { comingIn, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "egress",
  label: "Egress and access requests",
  description: "Enable domains within the install ceiling and answer access requests.",
  group: "Access",
  order: 20,
  permission: "team.egress.manage",
  status: comingIn("KOBE-39"),
});
