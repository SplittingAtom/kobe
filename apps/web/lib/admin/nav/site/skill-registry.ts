import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "skill-registry",
  label: "Skill Registry",
  description: "The Registry team, the Site judge and the rules a skill must meet to be submitted.",
  group: "Teams and agents",
  order: 31,
  minRole: "admin",
  status: READY,
});
