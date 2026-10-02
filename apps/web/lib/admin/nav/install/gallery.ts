import { READY, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "gallery",
  label: "Gallery agents",
  description: "Install-wide agents every team can use and fork: import, export, suspend.",
  group: "Teams and agents",
  order: 20,
  minRole: "admin",
  status: READY,
});
