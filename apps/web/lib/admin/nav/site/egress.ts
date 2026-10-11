import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "egress",
  label: "Egress ceiling",
  description: "The domains teams may enable for sandboxes, with presets.",
  group: "Safety",
  order: 20,
  minRole: "admin",
  status: READY,
});
