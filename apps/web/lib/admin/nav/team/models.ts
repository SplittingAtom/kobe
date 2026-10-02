import { comingIn, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "models",
  label: "Models",
  description: "The team's model subset and default model.",
  group: "Models and spend",
  order: 10,
  permission: "team.models.manage",
  status: comingIn("KOBE-44"),
});
