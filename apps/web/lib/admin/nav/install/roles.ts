import { READY, defineInstallSection } from "../types";

export default defineInstallSection({
  id: "roles",
  label: "Install roles",
  description: "Who is Owner and who are Admins; the Owner grants Admin and transfers ownership.",
  group: "People",
  order: 30,
  minRole: "admin",
  status: READY,
});
