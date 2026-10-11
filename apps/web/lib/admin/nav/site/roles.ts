import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "roles",
  label: "Site roles",
  description: "Who is Owner and who are Admins; the Owner grants Admin and transfers ownership.",
  group: "People",
  order: 30,
  minRole: "admin",
  status: READY,
});
