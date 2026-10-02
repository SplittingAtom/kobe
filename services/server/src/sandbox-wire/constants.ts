import {
  SANDBOX_HEARTBEAT_INTERVAL_MS,
  SANDBOX_HEARTBEAT_TIMEOUT_MS,
  SANDBOX_HELLO_TIMEOUT_MS,
} from "@kobe/protocol";

/** NOTIFY channel of the sandbox wire (ids only: any session may LISTEN on any channel). */
export const SANDBOX_CHANNEL = "kobe_sandbox";

/** Timings and limits; every one is overridable through `SandboxWireOptions.tuning` (tests). */
export interface WireTuning {
  readonly helloTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  /** How often a connection re-checks token liveness, user and membership. */
  readonly revalidateMs: number;
  /** `sandbox_connections.last_seen_at` refresh interval. */
  readonly touchMs: number;
  /** A connection row not touched for this long belongs to a dead replica. */
  readonly staleConnectionMs: number;
  /** Active runs of a sandbox gone this long are interrupted (D14); a reconnect within it resumes. */
  readonly lostGraceMs: number;
  /** Lost-sandbox sweep and command expiry interval (jittered). */
  readonly sweepMs: number;
  /** Delta coalescing window per run before a write (KOBE-29: one event per 50–100 ms). */
  readonly batchWindowMs: number;
  /** Most `pi.event` frames accepted in one transaction. */
  readonly batchMaxFrames: number;
  /**
   * Bytes of `pi.event` frames one run may hold in memory; past it new frames are dropped and
   * fetched again with `resend` once the queue drains (backpressure without pausing the socket).
   */
  readonly runQueueMaxBytes: number;
  /** Inbound frames per second per connection (token bucket) and the burst. */
  readonly frameRatePerSec: number;
  readonly frameBurst: number;
  /** Concurrent `policy.check`s per connection; beyond it, checks are denied. */
  readonly maxPendingPolicyChecks: number;
  /** Consecutive failed ingest writes before the connection is dropped. */
  readonly maxIngestFailures: number;
  /** Results are polled this often while waiting (hints may be lost). */
  readonly resultPollMs: number;
  /** Listener reconnect backoff bounds. */
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
  /** Default command deadlines by kind. */
  readonly commandTimeoutMs: {
    readonly "run.start": number;
    readonly "run.steer": number;
    readonly "run.stop": number;
    readonly "pi.command": number;
  };
}

export const WIRE_DEFAULTS: WireTuning = {
  helloTimeoutMs: SANDBOX_HELLO_TIMEOUT_MS,
  heartbeatIntervalMs: SANDBOX_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: SANDBOX_HEARTBEAT_TIMEOUT_MS,
  revalidateMs: 60_000,
  touchMs: 15_000,
  staleConnectionMs: 60_000,
  lostGraceMs: 30_000,
  sweepMs: 10_000,
  batchWindowMs: 75,
  batchMaxFrames: 50,
  runQueueMaxBytes: 16 * 1024 * 1024,
  frameRatePerSec: 500,
  frameBurst: 2_000,
  maxPendingPolicyChecks: 16,
  maxIngestFailures: 5,
  resultPollMs: 2_000,
  reconnectMinMs: 250,
  reconnectMaxMs: 10_000,
  commandTimeoutMs: {
    // Includes entry sync / session restore and waiting for a sandbox to (re)connect.
    "run.start": 120_000,
    "run.steer": 30_000,
    // The agent answers run.stop once the run has ended on the Pi side (after_step: next turn_end).
    "run.stop": 600_000,
    "pi.command": 60_000,
  },
};

/** Largest preview of a tool result kept in `tool.result` (the event payload cap is 256 KiB). */
export const TOOL_PREVIEW_MAX_CHARS = 16_384;
/** Largest tool input copied into `tool.call` (bigger inputs are summarised). */
export const TOOL_INPUT_MAX_BYTES = 64 * 1024;
/** Largest entry payload copied into `entry.committed` (larger ones are stored, not streamed). */
export const ENTRY_EVENT_PAYLOAD_MAX_BYTES = 64 * 1024;
/** session.restore part size budget (the frame cap is 4 MiB). */
export const RESTORE_PART_MAX_BYTES = 2 * 1024 * 1024;
/** Bounded memory of answered `pi.ui_request` ids per connection (dedupe of re-sent dialogs). */
export const UI_DEDUPE_MAX = 1_024;
