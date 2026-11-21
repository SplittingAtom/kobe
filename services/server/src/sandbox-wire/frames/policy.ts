import {
  CAPABILITY_FILE_EDITS,
  builtinToolDescriptor,
  type PolicyCheckFrame,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import type { AllowedArtifactCalls } from "../../artifacts/allowed.js";
import { POLICY_ANSWERED_MAX, remember } from "../connection-limits.js";
import type { WireContext } from "../context.js";
import type { RunCheck } from "../gated-frame.js";
import { decidePolicyCheck, denyFrame } from "../policy-check.js";
import type { TraceIntake } from "../trace-intake.js";
import type { SandboxTarget } from "../types.js";

/** What a `policy.check` needs from its connection (KOBE-706: moved out of connection.ts). */
export interface PolicyCheckPort {
  readonly ctx: WireContext;
  readonly target: SandboxTarget;
  readonly connectionId: string;
  /** Decisions in flight, by `run_id:request_id`. */
  readonly pending: Map<string, AbortController>;
  /** Answered request keys (a replay must not ask twice). */
  readonly answered: Set<string>;
  readonly allowed: Pick<AllowedArtifactCalls, "record">;
  readonly traces: TraceIntake | undefined;
  hasCapability(name: string): boolean;
  checkToolRun(runId: string, threadId: string, frameType: string): RunCheck;
  /** Whether the run's lease here has ended; undefined without a lease. */
  leaseEnded(runId: string): boolean | undefined;
  takeDeniedToken(runId: string): boolean;
  send(frame: ServerToSandboxFrame): boolean;
}

const runEnded = (frame: PolicyCheckFrame) =>
  denyFrame(frame, [], "The run has ended, so the tool call was denied.", "run_not_active");

/**
 * `policy.check`: the server decides every tool call (D-3). One answer per request id; a run that
 * ended while deciding gets a deny whatever the decision was; an allowed call's input is recorded
 * (by hash) before the answer reaches the sandbox, which the tool-frame gate checks later.
 */
export function onPolicyCheck(c: PolicyCheckPort, frame: PolicyCheckFrame): void {
  const check = c.checkToolRun(frame.run_id, frame.thread_id, "policy.check");
  if (check === "violation") return;
  if (check === "ended") {
    c.send(runEnded(frame));
    return;
  }
  if (c.pending.size >= c.ctx.tuning.maxPendingPolicyChecks) {
    c.send(denyFrame(frame, [], "Too many tool calls are waiting for a decision. Try again."));
    return;
  }
  const key = `${frame.run_id}:${frame.request_id}`;
  // One answer per request id, also after it was answered (a replay must not ask twice).
  if (c.pending.has(key) || c.answered.has(key)) return;
  const abort = new AbortController();
  c.pending.set(key, abort);
  c.ctx.metrics.policyChecks += 1;
  let deferred = false;
  void decidePolicyCheck(
    c.ctx.policy,
    {
      ...c.target,
      connectionId: c.connectionId,
      fileEdits: c.hasCapability(CAPABILITY_FILE_EDITS),
    },
    frame,
    abort.signal,
    (pending) =>
      c.send({
        v: 1,
        type: "policy.pending",
        request_id: frame.request_id,
        run_id: frame.run_id,
        tool_call_id: frame.tool_call_id,
        approval_id: pending.approvalId,
        expires_at: pending.expiresAt,
      }),
    () => c.takeDeniedToken(frame.run_id),
    () => {
      deferred = true;
    },
  ).then((result) => {
    c.pending.delete(key);
    remember(c.answered, key, POLICY_ANSWERED_MAX);
    // Tool spans get their name from this decision, never from the sandbox (KOBE-274): a denied
    // call's name is model text unless it names a built-in.
    const known = result.decision === "allow" || builtinToolDescriptor(frame.tool) !== undefined;
    c.traces?.noteToolCall(frame.run_id, frame.tool_call_id, known ? frame.tool : undefined);
    // A run that ended while we decided gets a deny, whatever the decision was.
    const ended = c.leaseEnded(frame.run_id);
    if (result.decision === "allow" && ended === false) {
      // D-3: the artifact input the server allowed, by hash, before the call reaches the sandbox.
      // KOBE-579: "a rule allowed it outright" is a positive mark on the allowance; a deferred
      // approval (or no entry at all) means the frame handler must ask (fail closed).
      c.allowed.record(frame.run_id, frame.tool_call_id, frame.tool, frame.input, {
        ruleAllowed: !deferred,
      });
    }
    c.send(ended === true && result.decision === "allow" ? runEnded(frame) : result);
  });
}
