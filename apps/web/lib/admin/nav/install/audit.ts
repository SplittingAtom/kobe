import { comingIn, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "audit",
  label: "Audit log",
  description: "The install-wide, append-only audit log.",
  group: "Governance",
  order: 10,
  minRole: "admin",
  status: comingIn("KOBE-15"),
});
