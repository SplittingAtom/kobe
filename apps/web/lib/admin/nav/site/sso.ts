import { READY, defineSiteSection } from "../types";

export default defineSiteSection({
  id: "sso",
  label: "Single sign-on",
  description: "Let people sign in with your organization's identity provider (Entra ID or OIDC).",
  group: "People",
  order: 40,
  minRole: "admin",
  status: READY,
  // Hidden while auth.sso.enabled is false (the kill switch); the API answers 404 then.
  feature: "sso",
});
