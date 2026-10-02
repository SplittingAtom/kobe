import { READY, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "settings",
  label: "Settings",
  description: "Install-wide sign-in settings such as required two-factor authentication.",
  group: "System",
  order: 20,
  minRole: "admin",
  status: READY,
});
