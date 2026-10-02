import { comingIn, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "retention",
  label: "Retention maximum",
  description: "The longest retention period any team may choose.",
  group: "Governance",
  order: 40,
  minRole: "admin",
  status: comingIn("KOBE-18"),
});
