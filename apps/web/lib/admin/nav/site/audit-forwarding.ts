import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "audit-forwarding",
  label: "Audit forwarding",
  description:
    "Whether audit events reach your SIEM: status, lag and the last error per destination.",
  group: "System",
  order: 15,
  minRole: "admin",
  status: READY,
});
