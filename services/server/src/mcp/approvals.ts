import type { ApprovalStore, ApprovalToken, JsonObject } from "@kobe/protocol";
import { authorizeApprovedCall, type ApprovalKey, type VerifyFailure } from "@kobe/protocol/node";

/**
 * Signed approvals at the MCP enforcement point (D29: "MCP calls are enforced a second time at the
 * MCP proxy"; Gate 2: a tampered `kobe-policy` cannot execute an MCP write without a signed
 * approval). When the policy re-check says `require_approval`, the call runs only if a verifier
 * finds a signed approval for exactly this call, verifies it and consumes it — never otherwise.
 *
 * The narrow seam KOBE-37 plugs into is {@link McpApprovalVerifier}. Until it does, production uses
 * {@link DENY_UNVERIFIED_APPROVALS}: every call that needs approval is refused.
 */

/** The call as the server sees it (from its own state, never from the sandbox's claims). */
export interface McpApprovalCall {
  readonly teamId: string;
  readonly runId: string;
  /** Pi tool name (`mcp__<server>__<tool>`), as signed. */
  readonly tool: string;
  /** Only when the client named one (`_meta`); otherwise any approval of this run + tool + input. */
  readonly toolCallId?: string;
  /** The exact input about to be forwarded upstream (its canonical form is what the MAC covers). */
  readonly input: JsonObject;
  readonly now: Date;
}

export type McpApprovalFailure = VerifyFailure | "no_approval" | "unavailable";

export type McpApprovalResult =
  | { readonly ok: true; readonly approvalId: string }
  | { readonly ok: false; readonly reason: McpApprovalFailure };

export interface McpApprovalVerifier {
  /** Verifies and consumes (single use) a signed approval for `call`. Never throws. */
  authorize(call: McpApprovalCall): Promise<McpApprovalResult>;
}

/** Deny-by-default until KOBE-37's approvals are wired: nothing is authorised. */
export const DENY_UNVERIFIED_APPROVALS: McpApprovalVerifier = {
  authorize: () => Promise.resolve({ ok: false, reason: "unavailable" }),
};

/**
 * Where signed tokens of allowed approvals are found (KOBE-37 owns the `approvals` table): the
 * tokens of this run's `allowed` approvals for this tool, newest first, at most `limit`. The token
 * is rebuilt from the row (`input_hmac` is its `mac`); the sandbox never supplies it.
 */
export interface ApprovalTokenSource {
  candidates(query: {
    readonly teamId: string;
    readonly runId: string;
    readonly tool: string;
    readonly toolCallId?: string;
    readonly limit: number;
  }): Promise<readonly ApprovalToken[]>;
}

export interface SignedApprovalVerifierDeps {
  readonly tokens: ApprovalTokenSource;
  /** Stateful half: status, run state and the single-use consume (protocol `ApprovalStore`). */
  readonly store: ApprovalStore;
  /** Verification keys by `kid` (rotation); the key never leaves the server. */
  readonly keyFor: (kid: string) => ApprovalKey | undefined;
  /** Candidates checked per call (default 8): bounds work for a run with many approvals. */
  readonly maxCandidates?: number;
  readonly onError?: (error: unknown) => void;
}

/** Most specific first: a failure later in verification says more about why the call was refused. */
const FAILURE_RANK: readonly McpApprovalFailure[] = [
  "not_consumable",
  "run_inactive",
  "record_mismatch",
  "not_allowed",
  "expired",
  "bad_mac",
  "unknown_key",
  "binding_mismatch",
  "malformed",
  "no_approval",
  "unavailable",
];

function mostSpecific(failures: readonly McpApprovalFailure[]): McpApprovalFailure {
  return FAILURE_RANK.find((f) => failures.includes(f)) ?? "no_approval";
}

/**
 * The real verifier over `@kobe/protocol/node` `authorizeApprovedCall` (both normative halves):
 * token schema, binding (team, run, tool, tool_call_id), key, expiry, MAC over the input about to
 * run, then the row's status and `input_hmac`, the run still active, and one conditional consume.
 *
 * Without a client-supplied `tool_call_id` (Pi's MCP client cannot attach one, see the ledger) the
 * expected id is each candidate's own: the approval then authorises exactly its run, tool and input,
 * once. A forged, replayed, expired or input-changed token fails; no candidate → `no_approval`.
 */
export function createSignedApprovalVerifier(
  deps: SignedApprovalVerifierDeps,
): McpApprovalVerifier {
  const limit = deps.maxCandidates ?? 8;
  return {
    async authorize(call) {
      try {
        const candidates = await deps.tokens.candidates({
          teamId: call.teamId,
          runId: call.runId,
          tool: call.tool,
          ...(call.toolCallId === undefined ? {} : { toolCallId: call.toolCallId }),
          limit,
        });
        const failures: McpApprovalFailure[] = [];
        for (const token of candidates.slice(0, limit)) {
          const result = await authorizeApprovedCall({
            token,
            expected: {
              team_id: call.teamId,
              run_id: call.runId,
              tool: call.tool,
              tool_call_id: call.toolCallId ?? token.tool_call_id,
            },
            input: call.input,
            now: call.now,
            keyFor: deps.keyFor,
            store: deps.store,
          });
          if (result.ok) return { ok: true, approvalId: result.token.approval_id };
          failures.push(result.reason);
        }
        return {
          ok: false,
          reason: failures.length === 0 ? "no_approval" : mostSpecific(failures),
        };
      } catch (error) {
        try {
          deps.onError?.(error);
        } catch {
          // Reporting must never turn a refusal into an exception.
        }
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}
