import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** MCP Connectors & Web Search (KOBE-58–63). */
export const connectors = defineDomain({
  // Team enablement and exposure of a connector (KOBE-58 minimal model; KOBE-60 manages it).
  team: ["team_connectors"],
  installWide: ["connectors", "connector_grants"],
  grants: {
    // The connector registry (install admins, KOBE-59): server URL, auth kind, pinned tools; no
    // team data. Deleting a connector cascades into every team's `team_connectors` row for it
    // (intended: it left the registry; KOBE-59 audits it). The only cascade from this table.
    connectors: ALL_PRIVILEGES,
  },
  teamReferencing: {},
});
