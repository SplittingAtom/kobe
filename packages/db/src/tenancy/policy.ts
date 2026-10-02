import { defineDomain } from "./types.js";

/** Policy, Approvals & Egress (KOBE-35–39). */
export const policy = defineDomain({
  team: [],
  installWide: ["egress_domains"],
  grants: {},
  teamReferencing: {},
});
