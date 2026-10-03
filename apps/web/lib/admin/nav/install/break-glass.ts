import { READY, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "break-glass",
  label: "Break-glass",
  description: "Request and approve time-boxed, read-only, audited access to one team.",
  group: "Governance",
  order: 20,
  minRole: "admin",
  status: READY,
});
