import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "invites",
  label: "Invitations",
  description: "Invite people into Kobe by email; resend or revoke open invitations.",
  group: "People",
  order: 20,
  minRole: "admin",
  status: READY,
});
