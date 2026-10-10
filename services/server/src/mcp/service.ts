import { withTeam, type Envelope, type KobeDb, type PinnedTool } from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";
import type { OauthIo } from "../connectors/oauth/http.js";
import { revealCredential, type RevealOutcome } from "../connectors/grants.js";
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
  /**
   * The principal's own decrypted credential (API key, or OAuth access token) for an enabled
   * `api_key` / `oauth` connector (KOBE-108, KOBE-109). The user
   * is the principal's, taken from the verified sandbox token: there is no way to ask for
   * another user's. Only the internal API (internal key) calls this; the key goes to the proxy.
   */
  revealCredential(principal: McpPrincipal, connectorId: string): Promise<RevealOutcome>;
}

export interface McpServiceOptions {
  readonly db: KobeDb;
  /** The policy engine's inputs (rules, settings, registry with the MCP catalog, connector state). */
  readonly policy: PolicySources;
  readonly runContext: RunPolicyContextSource;
  /** KOBE-37 seam; deny-by-default until approvals are wired. */
  readonly approvals?: McpApprovalVerifier;
  /** Install envelope (KOBE-107) that opens users' sealed keys; unset: no credential is served. */
  readonly envelope?: Envelope;
  readonly now?: () => Date;
  /** Pinned-address client for OAuth token refresh (KOBE-110); unset: expired tokens are not refreshed. */
  readonly oauthIo?: OauthIo;
}

/** A `tools/list` for a connector the team has not enabled: audited, throttled like denied calls. */
async function auditListRefused(
  db: KobeDb,
  principal: McpPrincipal,
  connectorId: string,
  limiter: ReturnType<typeof createRateLimiter>,
): Promise<void> {
  if (limiter.take(principal.sandboxId) !== 0) return;
  try {
    await withTeam(db, principal.teamId, (tx) =>
      recordAudit(tx, {
        action: "mcp.list_refused",
        teamId: principal.teamId,
        actor: { kind: "user", id: principal.userId },
        target: {
          sandboxId: principal.sandboxId,
          userId: principal.userId,
          connectorId,
          reason: "connector_not_enabled",
        },
      }),
    );
  } catch (err) {
    logger.error({ err }, "mcp: refused tools/list could not be audited");
  }
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
      if (!connector) {
        await auditListRefused(options.db, principal, connectorId, deniedAudits);
        return undefined;
      }
      return {
        connector: { id: connector.id, name: connector.name },
        tools: exposedTools(connector),
      };
    },
    decide: (principal, request) => decideMcpCall(deps, principal, request),
    revealCredential: (principal, connectorId) =>
      options.envelope
        ? revealCredential(
            options.db,
            options.envelope,
            {
              teamId: principal.teamId,
              userId: principal.userId,
              connectorId,
            },
            undefined,
            options.oauthIo,
          )
        : Promise.resolve({ ok: false, failure: "unavailable" }),
  };
}
