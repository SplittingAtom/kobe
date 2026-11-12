/**
 * An audit event caused through a Kobe MCP admin tool (KOBE-623, spec kobe-admin-mcp §7): the
 * server's `viaAgent` on team and site audit events.
 */
export interface ViaAgent {
  readonly threadId: string;
  readonly runId: string;
  readonly toolCallId: string;
  /** The viewer may open the thread now (the server checked: member, owner or shared). */
  readonly threadOpen: boolean;
}
