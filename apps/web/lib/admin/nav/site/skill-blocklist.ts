import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "skill-blocklist",
  label: "Skill blocklist",
  description: "Skill content hashes that never load anywhere on the site.",
  group: "Safety",
  order: 30,
  minRole: "admin",
  status: READY,
});
