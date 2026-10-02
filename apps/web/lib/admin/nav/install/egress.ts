import { comingIn, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "egress",
  label: "Egress ceiling",
  description: "The domains teams may enable for sandboxes, with presets.",
  group: "Safety",
  order: 20,
  minRole: "admin",
  status: comingIn("KOBE-38"),
});
