import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "teams",
  label: "Teams",
  description: "Create teams with their first team admin, rename them and read rosters.",
  group: "Teams and agents",
  order: 10,
  minRole: "admin",
  status: READY,
});
