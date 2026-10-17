import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "audit",
  label: "Audit log",
  description: "The site-wide, append-only audit log.",
  group: "Governance",
  order: 10,
  minRole: "admin",
  // GET /v1/site/audit and /integrity (KOBE-15, KOBE-17); the page is KOBE-291.
  status: READY,
});
