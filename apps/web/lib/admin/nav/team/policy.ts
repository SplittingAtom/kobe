import { comingIn, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "policy",
  label: "Policy",
  description: "Team ask and allow rules (they can only tighten the install floor).",
  group: "Access",
  order: 30,
  permission: "team.policy.manage",
  status: comingIn("KOBE-35"),
});
