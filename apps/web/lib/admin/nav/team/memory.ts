import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "memory",
  label: "Memory",
  description:
    "The workspace's memories for curators (edit, import, export) and its memory switches.",
  group: "Workspace settings",
  order: 70,
  permission: "team.memory.curate",
  status: READY,
});
