import { READY, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "skill-blocklist",
  label: "Skill blocklist",
  description: "Skill content hashes that never load anywhere in the install.",
  group: "Safety",
  order: 30,
  minRole: "admin",
  status: READY,
});
