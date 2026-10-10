import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "connectors",
  label: "Connectors",
  description: "Enable registered connectors for the team and choose their exposure.",
  group: "Access",
  order: 10,
  permission: "team.connectors.manage",
  status: READY,
});
