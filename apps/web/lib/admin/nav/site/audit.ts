import { comingIn, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "audit",
  label: "Audit log",
  description: "The site-wide, append-only audit log.",
  group: "Governance",
  order: 10,
  minRole: "admin",
  status: comingIn("KOBE-15"),
});
