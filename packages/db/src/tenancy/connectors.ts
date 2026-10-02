import { defineDomain } from "./types.js";

/** MCP Connectors & Web Search (KOBE-58–63). */
export const connectors = defineDomain({
  team: [],
  installWide: ["connectors", "connector_grants"],
  grants: {},
  teamReferencing: {},
});
