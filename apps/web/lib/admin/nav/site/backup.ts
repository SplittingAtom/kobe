import { comingIn, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "backup",
  label: "Backup status",
  description: "When the last backup ran and what it covered.",
  group: "System",
  order: 30,
  minRole: "admin",
  status: comingIn("KOBE-11"),
});
