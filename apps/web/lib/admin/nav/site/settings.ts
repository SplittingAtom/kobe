import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "settings",
  label: "Settings",
  description: "Site-wide sign-in settings such as required two-factor authentication.",
  group: "System",
  order: 20,
  minRole: "admin",
  status: READY,
});
