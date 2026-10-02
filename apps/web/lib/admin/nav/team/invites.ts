import { READY, defineTeamSection } from "../types";

export default defineTeamSection({
  id: "invites",
  label: "Invitations",
  description: "Invite people into the team by email; they join when they accept.",
  group: "People",
  order: 20,
  permission: "team.members.manage",
  status: READY,
});
