import { comingIn, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "policy-floor",
  label: "Policy floor",
  description: "Install-wide deny rules and the minimum approval mode every team inherits.",
  group: "Safety",
  order: 10,
  minRole: "admin",
  status: comingIn("KOBE-35"),
});
