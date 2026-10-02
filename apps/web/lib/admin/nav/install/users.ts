import { READY, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "users",
  label: "Users",
  description: "Everyone with a Kobe account: install role, 2FA, deactivate and reactivate.",
  group: "People",
  order: 10,
  minRole: "admin",
  status: READY,
});
