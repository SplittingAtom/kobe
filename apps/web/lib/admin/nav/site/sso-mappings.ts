import { READY, defineSiteSection } from "../types";

// KOBE-627: the access mappings of single sign-on providers. KOBE-626's Single sign-on page may
// absorb this section (spec sso-oidc-scim §7: provider → Access mappings).
export default defineSiteSection({
  id: "sso-mappings",
  label: "SSO access mappings",
  description: "Which identity provider app roles or groups give which team role, in which team.",
  group: "People",
  order: 45,
  minRole: "admin",
  status: READY,
});
