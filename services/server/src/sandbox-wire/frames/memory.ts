import {
  CAPABILITY_MEMORY,
  CAPABILITY_SEMANTIC_MEMORY,
  type SandboxToServerFrame,
} from "@kobe/protocol";
import {
  putMemory,
  readMemory,
  showMemory,
  type MemoryRefusal,
  type MemoryReply,
} from "../../memory/agent.js";
import type { RecalledItems } from "../../memory/recalled.js";
import type { GateRefusal, InFlight, ToolFrameSpec } from "../gated-frame.js";
import type { ConnectionPort } from "./port.js";

type MemoryFrame<T extends "memory.put" | "memory.read" | "memory.show"> = Extract<
  SandboxToServerFrame,
  { type: T }
>;
type Reason = MemoryRefusal | "capability_missing" | "input_mismatch";

/** What the memory frames share on one connection. */
export interface MemoryFrameDeps {
  readonly port: ConnectionPort;
  /** Memory requests in flight on this connection (all three kinds together). */
  readonly inFlight: InFlight;
  /** Saved memories this connection's `recall` answers named, per run (KOBE-399). */
  readonly recalled: RecalledItems;
  /** Aborts pending project-memory approvals when the connection ends. */
  readonly signal: AbortSignal;
}

interface Messages {
  readonly capability: string;
  readonly ended: string;
  readonly mismatch: string;
  readonly busy: string;
}

/** The refusals the three memory kinds share: audited (reason only), answered `memory.result`. */
function refuser<F extends MemoryFrame<"memory.put" | "memory.read" | "memory.show">>(
  port: ConnectionPort,
  audit: (frame: F, reason: Reason) => void,
  messages: Messages,
) {
  return (frame: F, refusal: GateRefusal<"check">): void => {
    const answer = (reply: MemoryReply) =>
      port.send({ v: 1, type: "memory.result", request_id: frame.request_id, ...reply });
    const refuse = (reason: Reason, message: string) => {
      audit(frame, reason);
      answer({ ok: false, error: { code: "not_allowed", message } });
    };
    switch (refusal.stage) {
      case "capability":
        refuse("capability_missing", messages.capability);
        return;
      case "ended":
        refuse("run_not_active", messages.ended);
        return;
      case "verdict":
        refuse(
          refusal.verdict === "input_mismatch" ? "input_mismatch" : "not_allowed",
          refusal.verdict === "input_mismatch"
            ? messages.mismatch
            : "This tool call was not allowed for this tool.",
        );
        return;
      case "busy":
        answer({ ok: false, error: { code: "storage_failed", message: messages.busy } });
        return;
    }
  };
}

const answerer = (port: ConnectionPort, requestId: string) => (reply: MemoryReply) =>
  port.send({ v: 1, type: "memory.result", request_id: requestId, ...reply });

/**
 * `memory.put` (KOBE-156). Past the gate (`memory`, the run leased here and active, this
 * `remember` call allowed here with the same canonical input hash, D-3), scope switches, project
 * membership, the approval of a project write and the store are in `putMemory`.
 */
export function memoryPutSpec(
  d: MemoryFrameDeps,
): ToolFrameSpec<MemoryFrame<"memory.put">, "check"> {
  const { port } = d;
  const audit = (frame: MemoryFrame<"memory.put">, reason: Reason, scope?: "user" | "project") =>
    port.ctx.auditMemoryRefused(port.target, port.sandboxId, {
      op: "put",
      reason,
      scope: scope ?? frame.input.scope,
      runId: frame.run_id,
      toolCallId: frame.tool_call_id,
    });
  return {
    capabilities: [CAPABILITY_MEMORY],
    allowance: "check",
    tool: "remember",
    inFlight: d.inFlight,
    refuse: refuser(port, audit, {
      capability: "This sandbox did not announce memory.",
      ended: "The run has ended, so nothing was remembered.",
      mismatch: "The memory differs from the call that was allowed.",
      busy: "Too many memory writes are waiting. Try again.",
    }),
    act(frame) {
      const outcome = putMemory(port.ctx.memory, {
        teamId: port.target.teamId,
        userId: port.target.userId,
        runId: frame.run_id,
        threadId: frame.thread_id,
        connectionId: port.connectionId,
        toolCallId: frame.tool_call_id,
        input: frame.input,
        signal: d.signal,
        refused: (reason, scope) => audit(frame, reason, scope),
      });
      // The slot frees once the sandbox is answered; a project write waiting for approval after its
      // `pending_approval` answer is bounded by the approvals per run (broker), not by this counter.
      return outcome.reply.then(answerer(port, frame.request_id));
    },
  };
}

/** `memory.read` (KOBE-156): a read, bound to the allowed `recall` call (D-3) like a write. */
export function memoryReadSpec(
  d: MemoryFrameDeps,
): ToolFrameSpec<MemoryFrame<"memory.read">, "check"> {
  const { port } = d;
  const audit = (frame: MemoryFrame<"memory.read">, reason: Reason, scope?: "user" | "project") =>
    port.ctx.auditMemoryRefused(port.target, port.sandboxId, {
      op: "read",
      reason,
      ...(scope ? { scope } : {}),
      runId: frame.run_id,
      toolCallId: frame.tool_call_id,
    });
  return {
    capabilities: [CAPABILITY_MEMORY],
    allowance: "check",
    // D-3: the server decides every tool call; a recall that policy did not allow (deny rule, the
    // agent's tool list, approval mode) is not served, whatever the sandbox sends.
    tool: "recall",
    inFlight: d.inFlight,
    refuse: refuser(port, audit, {
      capability: "This sandbox did not announce memory.",
      ended: "The run has ended.",
      mismatch: "The recall differs from the call that was allowed.",
      busy: "Too many memory requests are waiting. Try again.",
    }),
    act: (frame) =>
      readMemory(port.ctx.memory, {
        teamId: port.target.teamId,
        userId: port.target.userId,
        runId: frame.run_id,
        threadId: frame.thread_id,
        input: frame.input,
        refused: (reason, scope) => audit(frame, reason, scope),
      }).then((reply) => {
        // KOBE-399: what this recall named may be shown with `show_memory_item` in this run.
        if (reply.ok && reply.op === "read" && reply.items !== undefined)
          d.recalled.add(frame.run_id, reply.items);
        answerer(port, frame.request_id)(reply);
      }),
  };
}

/**
 * `memory.show` (KOBE-399, `show_memory_item`): a read, bound to the allowed call like
 * `memory.read`; needs both `memory` and `semantic_memory`. `showMemory` answers only for an item
 * this run was given or recalled, and writes nothing.
 */
export function memoryShowSpec(
  d: MemoryFrameDeps,
): ToolFrameSpec<MemoryFrame<"memory.show">, "check"> {
  const { port } = d;
  const audit = (frame: MemoryFrame<"memory.show">, reason: Reason) =>
    port.ctx.auditMemoryRefused(port.target, port.sandboxId, {
      op: "read",
      reason,
      runId: frame.run_id,
      toolCallId: frame.tool_call_id,
    });
  return {
    capabilities: [CAPABILITY_MEMORY, CAPABILITY_SEMANTIC_MEMORY],
    allowance: "check",
    tool: "show_memory_item",
    inFlight: d.inFlight,
    refuse: refuser(port, audit, {
      capability: "This sandbox did not announce semantic memory.",
      ended: "The run has ended.",
      mismatch: "The call differs from the one that was allowed.",
      busy: "Too many memory requests are waiting. Try again.",
    }),
    act: (frame) =>
      showMemory(port.ctx.memory, {
        teamId: port.target.teamId,
        userId: port.target.userId,
        runId: frame.run_id,
        threadId: frame.thread_id,
        input: frame.input,
        recalled: (id) => d.recalled.scopeOf(frame.run_id, id),
        refused: (reason) => audit(frame, reason),
      }).then(answerer(port, frame.request_id)),
  };
}
