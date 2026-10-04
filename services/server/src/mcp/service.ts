import type { KobeDb, PinnedTool } from "@kobe/db";
import { createRateLimiter } from "../sandbox/rate-limit.js";
import type { RunPolicyContextSource } from "../sandbox-wire/types.js";
import { DENY_UNVERIFIED_APPROVALS, type McpApprovalVerifier } from "./approvals.js";
import { exposedTools, loadTeamConnector } from "./catalog.js";
import type { PolicySources } from "./fan-out.js";
import {
  decideMcpCall,
  type McpCallDecision,
  type McpCallRequest,
  type McpPrincipal,
} from "./decide.js";

/** Denied calls audited per sandbox: a burst of 20, then one per 3 s (the rest are logged). */
export const DENIED_AUDIT_RATE = { capacity: 20, refillPerSecond: 1 / 3 } as const;

/** What the MCP proxy asks the server (KOBE-58): the exposed tools, and a decision per call. */
export interface McpService {
  /** Pinned tools of an enabled connector the team exposes; undefined = not available. */
  listTools(
    principal: McpPrincipal,
    connectorId: string,
  ): Promise<{ connector: { id: string; name: string }; tools: PinnedTool[] } | undefined>;
  decide(principal: McpPrincipal, request: McpCallRequest): Promise<McpCallDecision>;
}

export interface McpServiceOptions {
  readonly db: KobeDb;
  /** The policy engine's inputs (rules, settings, registry with the MCP catalog, connector state). */
  readonly policy: PolicySources;
  readonly runContext: RunPolicyContextSource;
  /** KOBE-37 seam; deny-by-default until approvals are wired. */
  readonly approvals?: McpApprovalVerifier;
  readonly now?: () => Date;
}

export function createMcpService(options: McpServiceOptions): McpService {
  const deniedAudits = createRateLimiter(DENIED_AUDIT_RATE);
  const deps = {
    db: options.db,
    policy: options.policy,
    runContext: options.runContext,
    approvals: options.approvals ?? DENY_UNVERIFIED_APPROVALS,
    mayAuditDenied: (sandboxId: string) => deniedAudits.take(sandboxId) === 0,
    ...(options.now ? { now: options.now } : {}),
  };
  return {
    async listTools(principal, connectorId) {
      const connector = await loadTeamConnector(options.db, principal.teamId, connectorId);
      if (!connector) return undefined;
      return {
        connector: { id: connector.id, name: connector.name },
        tools: exposedTools(connector),
      };
    },
    decide: (principal, request) => decideMcpCall(deps, principal, request),
  };
}
