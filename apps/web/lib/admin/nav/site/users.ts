import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "users",
  label: "Users",
  description: "Everyone with a Kobe account: site role, 2FA, deactivate and reactivate.",
  group: "People",
  order: 10,
  minRole: "admin",
  status: READY,
});
