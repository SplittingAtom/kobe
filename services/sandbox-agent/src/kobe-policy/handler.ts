import type { CheckRequest, Verdict } from "./client.js";
import { deepFreeze, findPlainJsonIssue, stableJson } from "./plain-json.js";
import { MAX_TOOL_NAME_LENGTH, isWireId } from "./protocol.js";

/**
 * The `tool_call` handler (Pi 1.0.0; spec D29 calls it `beforeToolCall`). Every tool call — model
 * issued or nested (`ctx.executeTool`, e.g. each call a codemode script makes, ids `<parent>/<n>`) —
 * reaches it, and it returns nothing only when the server allowed exactly this call. Anything else
 * blocks: Pi turns `{block, reason}` into an error tool result, and a handler that throws blocks too.
 *
 * Only tool name, input and ids are sent: the server derives risk, scope and source from its own
 * registry (KOBE-35), so nothing the sandbox could claim about a tool is part of the request.
 */
export const BLOCK_PREFIX = "policy.denied:";

export interface PolicyChecker {
  check(request: CheckRequest): Promise<Verdict>;
}

/** The parts of Pi's `ToolCallEvent` this handler reads (kept structural: no Pi type dependency). */
export interface ToolCallEventLike {
  readonly toolName: unknown;
  readonly toolCallId: unknown;
  readonly parentToolCallId?: unknown;
  input: unknown;
}

export interface ToolCallContextLike {
  readonly signal?: AbortSignal | undefined;
}

export interface ToolCallBlock {
  readonly block: true;
  readonly reason: string;
}

const block = (reason: string): ToolCallBlock => ({
  block: true,
  reason: `${BLOCK_PREFIX} ${reason}`,
});

export function createToolCallHandler(policy: PolicyChecker) {
  return async (
    event: ToolCallEventLike,
    ctx: ToolCallContextLike,
  ): Promise<ToolCallBlock | undefined> => {
    try {
      return await decide(policy, event, ctx);
    } catch {
      return block("the policy check failed");
    }
  };
}

async function decide(
  policy: PolicyChecker,
  event: ToolCallEventLike,
  ctx: ToolCallContextLike,
): Promise<ToolCallBlock | undefined> {
  const { toolName, toolCallId, parentToolCallId } = event;
  if (typeof toolName !== "string" || toolName === "" || toolName.length > MAX_TOOL_NAME_LENGTH) {
    return block("invalid tool name");
  }
  if (!isWireId(toolCallId)) return block("invalid tool call id");
  if (parentToolCallId !== undefined && !isWireId(parentToolCallId)) {
    return block("invalid parent tool call id");
  }
  // The object Pi will execute with (same reference). Checked as it is now, i.e. after every
  // earlier handler's in-place mutation, then frozen so nothing can change it after the decision.
  const input = event.input;
  const issue = findPlainJsonIssue(input);
  if (issue !== undefined) return block(issue);
  const decided = input as Record<string, unknown>;
  deepFreeze(decided);
  const fingerprint = stableJson(decided);

  const verdict = await policy.check({
    toolCallId,
    ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
    tool: toolName,
    input: decided,
    signal: ctx.signal,
  });
  if (!verdict.allow) return block(verdict.reason);
  if (event.input !== decided || stableJson(event.input) !== fingerprint) {
    return block("the tool input changed while the policy decision was pending");
  }
  return undefined;
}
