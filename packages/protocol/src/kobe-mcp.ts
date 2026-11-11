/**
 * The built-in Kobe MCP connector (KOBE-618/619, spec kobe-admin-mcp §3): its fixed id, the same on
 * every site (`@kobe/db` `KOBE_BUILTIN_CONNECTOR_ID`, check-enforced on the row). The MCP proxy
 * routes `POST /v1/mcp/<this id>` to the server's internal listener (`/internal/v1/mcp/kobe/*`)
 * instead of an upstream server; nothing about it reaches a sandbox but the id.
 */
export const KOBE_BUILTIN_CONNECTOR_ID = "6b6f6265-0000-4000-8000-000000000001";
