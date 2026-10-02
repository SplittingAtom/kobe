import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "members",
  label: "Members and roles",
  description: "Who is in the team and their role; change roles or remove members.",
  group: "People",
  order: 10,
  permission: "team.members.manage",
  status: READY,
});
