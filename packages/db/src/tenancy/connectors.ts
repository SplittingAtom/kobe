import { ALL_PRIVILEGES, defineDomain } from "./types.js";

/** MCP Connectors & Web Search (KOBE-58–63). */
export const connectors = defineDomain({
  // Team enablement and exposure of a connector (KOBE-58 minimal model; KOBE-60 manages it), and
  // each user's own API-key grant for it (KOBE-108; sealed with the KOBE-107 envelope), and the
  // team's opt-in to web search (KOBE-113).
  team: ["team_connectors", "connector_grants", "team_web_search"],
  siteWide: ["connectors", "web_search_settings", "connector_site_keys", "connector_ui_resources"],
  grants: {
    // The connector registry (site admins, KOBE-59): server URL, auth kind, pinned tools; no
    // team data. Deleting a connector cascades into every team's `team_connectors` row for it
    // (intended). The registry API (KOBE-100) soft-deletes a connector teams still use instead.
    connectors: ALL_PRIVILEGES,
    // The web search provider and its sealed key (KOBE-113): one row, no team data. Teams opt in
    // through the team table `team_web_search`.
    web_search_settings: ALL_PRIVILEGES,
    // A connector's site-wide API key (KOBE-303), sealed like connector_grants: no team data.
    connector_site_keys: ALL_PRIVILEGES,
    // A connector's pinned MCP Apps `ui://` templates (KOBE-433): no team data; they cascade with
    // the connector.
    connector_ui_resources: ALL_PRIVILEGES,
  },
  teamReferencing: {},
});
