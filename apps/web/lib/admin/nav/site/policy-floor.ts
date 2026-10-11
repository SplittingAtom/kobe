import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "policy-floor",
  label: "Policy floor",
  description: "Site-wide deny rules and the minimum approval mode every team inherits.",
  group: "Safety",
  order: 10,
  minRole: "admin",
  status: READY,
});
