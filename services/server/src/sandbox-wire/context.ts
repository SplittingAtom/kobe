import type { ToolRegistry } from "@kobe/protocol";
import type { KobeDb } from "@kobe/db";
import type { Logger } from "pino";
import type { SandboxBus } from "./bus.js";
import type { WireTuning } from "./constants.js";
import type { PolicyCheckDeps } from "./policy-check.js";
import type { RunLifecycleHooks, SandboxLiveness, SandboxTarget, UiBroker } from "./types.js";

/** In-process counters (no metrics backend yet); logged and exposed by `SandboxWire.metrics()`. */
export interface WireMetrics {
  connectionsOpened: number;
  connectionsClosed: number;
  upgradesRefused: number;
  framesIn: number;
  framesAccepted: number;
  framesDuplicate: number;
  gaps: number;
  writes: number;
  malformedFrames: number;
  leaseViolations: number;
  lateFrames: number;
  policyChecks: number;
  commandsDelivered: number;
  runsInterrupted: number;
  runsCompleted: number;
}

export function newMetrics(): WireMetrics {
  return {
    connectionsOpened: 0,
    connectionsClosed: 0,
    upgradesRefused: 0,
    framesIn: 0,
    framesAccepted: 0,
    framesDuplicate: 0,
    gaps: 0,
    writes: 0,
    malformedFrames: 0,
    leaseViolations: 0,
    lateFrames: 0,
    policyChecks: 0,
    commandsDelivered: 0,
    runsInterrupted: 0,
    runsCompleted: 0,
  };
}

export type SandboxLimit =
  "frame_rate" | "byte_rate" | "frame_size" | "run_events" | "run_bytes" | "thread_entries";

export type LeaseViolation = "unknown_run" | "unknown_thread" | "unknown_command";

/** Everything a connection shares with its replica. */
export interface WireContext {
  readonly db: KobeDb;
  readonly bus: SandboxBus;
  readonly tuning: WireTuning;
  readonly replicaId: string;
  readonly tools: ToolRegistry;
  readonly policy: PolicyCheckDeps;
  readonly ui: UiBroker;
  readonly hooks: RunLifecycleHooks;
  readonly liveness: SandboxLiveness;
  readonly metrics: WireMetrics;
  readonly log: Logger;
  /** Records `sandbox.lease_violation` (throttled per sandbox and violation). */
  auditViolation(
    target: SandboxTarget,
    sandboxId: string,
    violation: LeaseViolation,
    frameType: string,
  ): void;
  /** Records `sandbox.limit_exceeded` (throttled per sandbox and limit). */
  auditLimit(target: SandboxTarget, sandboxId: string, limit: SandboxLimit, runId?: string): void;
  /** A command requested on this replica has a result (skip waiting for the NOTIFY round trip). */
  localResult(commandId: string): void;
  /** Tells KOBE-30 (hooks) that the wire ended a run; never throws. */
  runEnded(event: {
    teamId: string;
    runId: string;
    threadId: string;
    status: "completed" | "failed" | "interrupted";
  }): void;
  /** Whether (team, user) still may run a sandbox: account active and team member. */
  principalAllowed(target: SandboxTarget): Promise<boolean>;
}
