import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "skill-review",
  label: "Skill reviews",
  description:
    "The Registry queue: review each submitted skill version against the approved one, then approve, request changes or reject.",
  group: "Teams and agents",
  order: 32,
  minRole: "admin",
  grant: "skill_reviewer",
  status: READY,
});
