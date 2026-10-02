import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "policy",
  label: "Policy",
  description: "Team deny, ask and allow rules, inside the install floor.",
  group: "Access",
  order: 30,
  permission: "team.policy.manage",
  status: READY,
});
