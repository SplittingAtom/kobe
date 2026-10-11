import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "schedules",
  label: "Schedules",
  description: "Every member's scheduled runs: pause one, or resume one a team admin paused.",
  group: "Agents and skills",
  order: 25,
  permission: "team.schedules.pause",
  status: READY,
});
