import type { SandboxToServerFrame } from "@kobe/protocol";
import type { AllowedArtifactCalls, AllowedVerdict } from "../artifacts/allowed.js";

/**
 * The one gate every frame a tool sends passes before its action runs (KOBE-706, D-3: the server
 * decides every tool call). In this order, each stage answering the frame itself when it refuses:
 *
 * 1. capability: the connection announced every capability the kind needs (and the kind's own
 *    extra requirement, e.g. notebook storage configured);
 * 2. the kind's optional check before the run (a skill eval never proposes file edits);
 * 3. the run: leased here, active, not a compaction (`#checkToolRun`); a violation was already
 *    answered (and the connection closed), so nothing else is sent;
 * 4. the allowed call: this tool call was allowed here by the policy check, for this tool, with the
 *    same canonical input hash (`check`, or `consume` for single-use tools);
 * 5. the kind's optional check after the allowance (storage configured);
 * 6. the per-connection in-flight cap, when the kind has one;
 * 7. the action, which gets a {@link GatePassed} only this module can make.
 *
 * Tool frames are every sandbox frame that names a `tool_call_id`, except `policy.check` (the
 * decision itself) and the legacy `web_search.query` (answered unavailable, does nothing).
 * {@link ToolFrameSpecs} needs a spec for each of them, so a new tool frame does not compile until
 * it has one, and the connection dispatches them only through {@link runToolFrame}.
 */

/** Set by {@link GatePassed}'s static block; module-private, so only this module makes proofs. */
let mint: () => GatePassed;

/** Proof that the gate passed for a frame. Its constructor is private; only the gate makes one. */
export class GatePassed {
  readonly #passed = true;
  private constructor() {}
  static {
    mint = () => new GatePassed();
  }
  /** Always true; read so the private field is used. */
  get passed(): boolean {
    return this.#passed;
  }
}
/** The frames a tool sends after its policy check, which the gate guards. */
export type ToolFrame = Exclude<
  Extract<SandboxToServerFrame, { tool_call_id: string }>,
  { type: "policy.check" | "web_search.query" }
>;
export type ToolFrameType = ToolFrame["type"];
export type ToolFrameOf<K extends ToolFrameType> = Extract<ToolFrame, { type: K }>;

export type RunCheck = "ok" | "ended" | "violation";
/** `check` (idempotent actions) or `consume` (single use: a repeat is "replayed"). */
export type AllowanceMode = "check" | "consume";
export type GateVerdict<M extends AllowanceMode = AllowanceMode> = M extends "consume"
  ? AllowedVerdict | "replayed"
  : AllowedVerdict;

/** Why the gate refused a frame; the spec answers (and audits) it. */
export type GateRefusal<M extends AllowanceMode = AllowanceMode> =
  | { readonly stage: "capability" }
  | { readonly stage: "ended" }
  | { readonly stage: "verdict"; readonly verdict: Exclude<GateVerdict<M>, "ok"> }
  | { readonly stage: "busy" };

/** In-flight actions of one kind (or a group of kinds) on one connection. */
export interface InFlight {
  count: number;
}

/** What one kind of tool frame declares; the gate itself is not the kind's to write. */
export interface ToolFrameSpec<F extends ToolFrame, M extends AllowanceMode = AllowanceMode> {
  /** Every capability the connection must have announced (at least one). */
  readonly capabilities: readonly [string, ...string[]];
  /** A further requirement checked with the capabilities (e.g. storage configured). */
  readonly alsoRequires?: () => boolean;
  readonly allowance: M;
  /**
   * The tool the allowance must name; default the frame's `tool` (a frame without one and no
   * `tool` here names no allowed tool, so it is refused).
   */
  readonly tool?: string;
  /** Before the run check; true when it refused and answered the frame. */
  readonly beforeRun?: (frame: F) => boolean;
  /** After the allowance; true when it refused and answered the frame. */
  readonly afterAllowance?: (frame: F) => boolean;
  /** The kind's in-flight cap; refused as `busy` once `count` reached the connection's maximum. */
  readonly inFlight?: InFlight;
  /** Answers (and audits) a refusal; called at most once per frame. */
  refuse(frame: F, refusal: GateRefusal<M>): void;
  /**
   * The action, which answers the frame itself. Its in-flight slot (if any) is released when the
   * returned promise settles.
   */
  act(frame: F, passed: GatePassed): unknown;
}

/** Either allowance mode, each with its own refusals. */
export type AnyToolFrameSpec<F extends ToolFrame> =
  ToolFrameSpec<F, "check"> | ToolFrameSpec<F, "consume">;

/** A spec for every tool frame kind: a new kind does not compile until it has one. */
export type ToolFrameSpecs = { readonly [K in ToolFrameType]: AnyToolFrameSpec<ToolFrameOf<K>> };

/** What the connection lends the gate. */
export interface ToolFrameGate {
  hasCapability(name: string): boolean;
  checkToolRun(runId: string, threadId: string, frameType: string): RunCheck;
  readonly allowance: Pick<AllowedArtifactCalls, "check" | "consume">;
  /** The in-flight maximum per kind (`maxPendingArtifactPuts`). */
  readonly maxInFlight: number;
}

function allowanceOf<F extends ToolFrame, M extends AllowanceMode>(
  gate: ToolFrameGate,
  spec: ToolFrameSpec<F, M>,
  frame: F,
): GateVerdict<M> {
  const named: unknown = (frame as { tool?: unknown }).tool;
  const tool = spec.tool ?? (typeof named === "string" ? named : undefined);
  // Fail closed: a frame that names no tool (and a spec that names none) is never allowed.
  if (tool === undefined) return "not_allowed";
  const { run_id: runId, tool_call_id: toolCallId, input } = frame;
  return (
    spec.allowance === "consume"
      ? gate.allowance.consume(runId, toolCallId, tool, input)
      : gate.allowance.check(runId, toolCallId, tool, input)
  ) as GateVerdict<M>;
}

/** Runs the gate for one frame, then its action. Never throws for a refusal. */
export function runGatedToolFrame<F extends ToolFrame, M extends AllowanceMode>(
  gate: ToolFrameGate,
  spec: ToolFrameSpec<F, M>,
  frame: F,
): void {
  const capable =
    spec.capabilities.every((name) => gate.hasCapability(name)) && (spec.alsoRequires?.() ?? true);
  if (!capable) {
    spec.refuse(frame, { stage: "capability" });
    return;
  }
  if (spec.beforeRun?.(frame) === true) return;
  const run = gate.checkToolRun(frame.run_id, frame.thread_id, frame.type);
  if (run === "violation") return;
  if (run === "ended") {
    spec.refuse(frame, { stage: "ended" });
    return;
  }
  const verdict = allowanceOf(gate, spec, frame);
  if (verdict !== "ok") {
    spec.refuse(frame, { stage: "verdict", verdict: verdict as Exclude<GateVerdict<M>, "ok"> });
    return;
  }
  if (spec.afterAllowance?.(frame) === true) return;
  const slots = spec.inFlight;
  if (slots !== undefined) {
    if (slots.count >= gate.maxInFlight) {
      spec.refuse(frame, { stage: "busy" });
      return;
    }
    slots.count += 1;
  }
  // A synchronous throw propagates as it always did; the slot frees when the action settles (a
  // rejection stays the action's own to handle, as before).
  const action = spec.act(frame, mint());
  if (slots !== undefined) {
    void Promise.resolve(action).finally(() => {
      slots.count -= 1;
    });
  }
}

/** Whether a decoded frame is a tool frame (one of `specs`' kinds), for dispatch. */
export function isToolFrame(
  frame: SandboxToServerFrame,
  specs: ToolFrameSpecs,
): frame is ToolFrame {
  return Object.hasOwn(specs, frame.type);
}

/** Dispatches a tool frame to its kind's spec through the gate. */
export function runToolFrame<K extends ToolFrameType>(
  gate: ToolFrameGate,
  specs: ToolFrameSpecs,
  frame: ToolFrameOf<K>,
): void {
  const spec = specs[frame.type as K] as AnyToolFrameSpec<ToolFrameOf<K>>;
  // Either mode: the spec's refusals match the verdicts its own mode can give.
  runGatedToolFrame(gate, spec as ToolFrameSpec<ToolFrameOf<K>>, frame);
}
