import { comingIn, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "inventory",
  label: "Inventory",
  description: "Every agent, version, schedule and score in the team.",
  group: "Agents and skills",
  order: 20,
  permission: "team.agents.suspend",
  status: comingIn("KOBE-48"),
});
