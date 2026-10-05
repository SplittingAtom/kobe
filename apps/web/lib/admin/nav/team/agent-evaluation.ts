import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "agent-evaluation",
  label: "Agent evaluation",
  description: "Run an Orbit safety eval before agents publish, and set the allowed attack rate.",
  group: "Agents and skills",
  order: 40,
  permission: "team.eval.manage",
  status: READY,
});
