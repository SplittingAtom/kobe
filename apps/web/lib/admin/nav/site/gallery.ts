import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "gallery",
  label: "Gallery agents",
  description: "Site-wide agents every team can use and fork: import, export, suspend.",
  group: "Teams and agents",
  order: 20,
  minRole: "admin",
  status: READY,
});
