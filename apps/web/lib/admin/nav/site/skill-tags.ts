import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "skill-tags",
  label: "Skill tags",
  description: "Topic tags and Site default skills, which every team gets.",
  group: "Teams and agents",
  order: 30,
  minRole: "admin",
  status: READY,
});
