import type { PinOutcome } from "../connectors/pinning.js";

/** What each pin or probe failure means, in plain words (never the remote server's own text). */
export const PIN_MESSAGES: Record<Extract<PinOutcome, { ok: false }>["failure"], string> = {
  url_not_allowed: "The address is not allowed by this site's connector policy.",
  forbidden_address: "The server resolves to an address Kobe may not reach.",
  unreachable: "The server could not be reached.",
  timeout: "The server did not answer in time.",
  auth_required:
    "The server asked for credentials. Kobe probes with the connector's site-wide key, else your own key for it (add one at My connector keys in a team that enabled it); never a member's. Tools stay unpinned (none are offered).",
  http_error: "The server answered with an error.",
  protocol_error: "The server did not answer as an MCP server.",
  too_large: "The server's tool list was too large.",
  rpc_error: "The server refused the tools/list request.",
  proxy_unavailable: "Kobe's MCP proxy could not be reached, so nothing was probed.",
  invalid_tool: "The server listed a tool Kobe cannot pin (invalid name, description or schema).",
  ambiguous_tool_names:
    "The server lists tools whose names collide once - . and _ are treated alike, so none was pinned.",
  ui_resource_invalid:
    "An app template (ui://) of the server is not one UTF-8 HTML document of type text/html;profile=mcp-app of at most 512 KiB, so nothing was pinned.",
  ui_resource_hash_mismatch:
    "An app template's declared contentHash does not match its bytes, so nothing was pinned.",
  already_pinned: "This connector already has pinned tools; changing them needs re-approval.",
  changed: "The connector changed while it was being probed. Probe it again.",
};
