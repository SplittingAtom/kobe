import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "storage",
  label: "Storage and history",
  description:
    "Bytes and objects per workspace and project, the object budget, and how long project history is kept.",
  group: "Workspace settings",
  order: 80,
  // GET/PUT /v1/team/storage (KOBE-579).
  permission: "team.projects.manage",
  status: READY,
});
