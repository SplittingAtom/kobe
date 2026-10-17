import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "backup",
  label: "Backup and restore",
  description: "How to back up and restore the site, and the last restore.",
  group: "System",
  order: 30,
  minRole: "admin",
  // `kobe backup`/`restore` are a CLI (KOBE-11); the page shows the last restore from the audit
  // log and the retention pause, plus the steps (KOBE-291).
  status: READY,
});
