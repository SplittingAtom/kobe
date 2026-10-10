import type { ToolRegistry } from "@kobe/protocol";
import type {
  ARTIFACT_PUT_REFUSALS,
  FILE_SHARE_REFUSALS,
  MEMORY_REFUSALS,
  PROJECT_FILE_REFUSALS,
  KobeDb,
  WEB_SEARCH_REFUSALS,
} from "@kobe/db";
import type { WebSearchService } from "../web-search/service.js";
import type { Logger } from "pino";
import type { SandboxBus } from "./bus.js";
import type { WireTuning } from "./constants.js";
import type { ArtifactPutDeps } from "../artifacts/put.js";
import type { FileShareDeps } from "../files/share.js";
import type { MemoryAgentDeps } from "../memory/agent.js";
import type { ProjectMounts } from "../projects/mounts.js";
import type { ProposeDeps } from "../projects/proposals.js";
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
  /** Translated events dropped for failing their protocol schema or size bound. */
  eventsDropped: number;
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
    eventsDropped: 0,
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
  /** Derived run token key (KOBE-118); unset: no run tokens are minted. */
  readonly runTokenKey?: Uint8Array;
  readonly tools: ToolRegistry;
  readonly policy: PolicyCheckDeps;
  /** Storage for `artifact.put` (KOBE-129). */
  readonly artifacts: ArtifactPutDeps;
  /** Storage for `file.share` (KOBE-150). */
  readonly fileShare: FileShareDeps;
  /** Storage, approvals and membership for `memory.put` / `memory.read` / `run.start.memory` (KOBE-156). */
  readonly memory: MemoryAgentDeps;
  /** Project file mounts (KOBE-162): refreshed at run start. Undefined in tests that don't need it. */
  readonly projectMounts?: ProjectMounts;
  /** Storage, approvals and membership for `project.file_propose` (KOBE-162). */
  readonly projectFiles: ProposeDeps;
  /** Runs `web_search.query` (KOBE-114). */
  readonly webSearch: WebSearchService;
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
  /** Records `sandbox.artifact_refused` (throttled per user and reason); never carries content. */
  auditArtifactRefused(
    target: SandboxTarget,
    sandboxId: string,
    refusal: {
      reason: (typeof ARTIFACT_PUT_REFUSALS)[number];
      tool: "create_artifact" | "update_artifact";
      runId: string;
      toolCallId: string;
    },
  ): void;
  /** Records `sandbox.file_share_refused` (throttled per user and reason); never carries content. */
  auditFileShareRefused(
    target: SandboxTarget,
    sandboxId: string,
    refusal: {
      reason: (typeof FILE_SHARE_REFUSALS)[number];
      runId: string;
      toolCallId: string;
    },
  ): void;
  /** Records `sandbox.project_file_refused` (throttled per user and reason); never carries names or content. */
  auditProjectFileRefused(
    target: SandboxTarget,
    sandboxId: string,
    refusal: {
      reason: (typeof PROJECT_FILE_REFUSALS)[number];
      runId: string;
      toolCallId: string;
    },
  ): void;
  /** Records `sandbox.memory_refused` (throttled per user, op and reason); never carries content. */
  auditMemoryRefused(
    target: SandboxTarget,
    sandboxId: string,
    refusal: {
      op: "put" | "read";
      reason: (typeof MEMORY_REFUSALS)[number];
      scope?: "user" | "project";
      runId: string;
      toolCallId?: string;
    },
  ): void;
  /** Records `sandbox.web_search_refused` (throttled per user and reason); never carries the query. */
  auditWebSearchRefused(
    target: SandboxTarget,
    sandboxId: string,
    refusal: {
      reason: (typeof WEB_SEARCH_REFUSALS)[number];
      runId: string;
      toolCallId: string;
    },
  ): void;
  /** Records `sandbox.token_rejected` (throttled): a signed token refused after verification. */
  auditTokenRejected(
    claims: { sandboxId: string; teamId: string; userId: string },
    reason: "not_live" | "not_allowed" | "sandbox_mismatch",
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
