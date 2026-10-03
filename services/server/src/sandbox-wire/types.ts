import type {
  ApprovalMode,
  ApprovalToken,
  ErrorInfo,
  PiBridgeCommand,
  PiExtensionUiRequest,
  PiExtensionUiResponse,
  PiThreadConfig,
  PolicyDecision,
  PolicyReason,
  RunStatus,
  SessionTokenClaims,
} from "@kobe/protocol";
import type { KobeTx } from "@kobe/db";

/** The (team, user) sandbox a command targets (D11: one sandbox per user and team). */
export interface SandboxTarget {
  readonly teamId: string;
  readonly userId: string;
}

/**
 * Verifies the bearer token of a `/v1/sandbox/connect` upgrade for audience `kobe.sandbox-wire`
 * (KOBE-22 `verifySessionToken`: HS256 pinned, exact header, audience-bound key). Throws on any
 * invalid token. Liveness of `sub` is {@link SandboxLiveness}'s question.
 */
export type SessionTokenVerifier = (token: string) => SessionTokenClaims;

/**
 * Whether sandbox `sub` is still the live sandbox of (team, user): KOBE-22's claim `u-<user>` in
 * the team namespace with that UID. Checked at connect and periodically while connected.
 */
export interface SandboxLiveness {
  isLive(claims: { sandboxId: string; teamId: string; userId: string }): Promise<boolean>;
}

/**
 * KOBE-25 seam: start or resume the (team, user) sandbox when a command finds it disconnected.
 * Rejecting with a {@link SandboxWakeError} fails the waiting command at once (waiting cannot
 * help); any other rejection is logged and the command waits for its deadline.
 */
export interface SandboxWaker {
  /** `context.runId`: the run whose `run.start` needs the sandbox (it is told `sandbox.waking`). */
  wake(target: SandboxTarget, context?: WakeContext): Promise<void>;
}

export interface WakeContext {
  readonly runId?: string;
}

/** A wake that cannot succeed by waiting: no verified isolation runtime, an offboarded sandbox. */
export class SandboxWakeError extends Error {
  constructor(
    readonly code: "isolation_runtime_missing" | "sandbox_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SandboxWakeError";
  }
}

/** Outcome of one server → sandbox command (`command.result`, or a server-side failure). */
export type CommandOutcome =
  | { readonly ok: true; readonly data?: unknown }
  | { readonly ok: false; readonly error: ErrorInfo };

/** Server-side failure codes of a command (besides the agent's own `SandboxErrorCode`s). */
export const COMMAND_FAILURES = {
  timeout: "timeout", // no result before the command's deadline
  connectionLost: "connection_lost", // delivered, then the connection closed before its result
  sandboxLost: "sandbox_lost", // run.start for a run the reconnected sandbox no longer has
  sessionUnavailable: "session_unavailable", // entry sync/restore before run.start failed
} as const;

export interface RunStartRequest {
  readonly runId: string;
  readonly threadId: string;
  readonly message: string;
  readonly attachments?: readonly { readonly path: string; readonly mime_type: string }[];
  readonly parentEntryId?: string;
  readonly config?: PiThreadConfig;
}

export interface RunSteerRequest {
  readonly runId: string;
  readonly threadId: string;
  readonly message: string;
}

export interface RunStopRequest {
  readonly runId: string;
  readonly threadId: string;
  readonly mode: "abort" | "after_step";
  readonly reason: "user_cancelled" | "budget_exhausted" | "approval_expired";
}

export interface PiCommandRequest {
  readonly threadId: string;
  /** Allow-listed Pi RPC command; its `id` is replaced by the wire. */
  readonly command: PiBridgeCommand;
}

export interface SendOptions {
  /** How long to wait for the result (default per kind). */
  readonly timeoutMs?: number;
}

/**
 * The routing API (KOBE-30 orchestrator, KOBE-25 wake, KOBE-26 retry, KOBE-37 approvals). Callable
 * on any replica: the command is stored in Postgres and delivered by whichever replica holds the
 * sandbox's socket (NOTIFY hint), which writes the result back. Resolves with the sandbox's
 * `command.result` or a server-side failure; never rejects for sandbox-side problems.
 */
export interface SandboxRouter {
  startRun(
    target: SandboxTarget,
    run: RunStartRequest,
    options?: SendOptions,
  ): Promise<CommandOutcome>;
  steerRun(
    target: SandboxTarget,
    steer: RunSteerRequest,
    options?: SendOptions,
  ): Promise<CommandOutcome>;
  stopRun(
    target: SandboxTarget,
    stop: RunStopRequest,
    options?: SendOptions,
  ): Promise<CommandOutcome>;
  piCommand(
    target: SandboxTarget,
    request: PiCommandRequest,
    options?: SendOptions,
  ): Promise<CommandOutcome>;
  /** True while some replica holds a live (heartbeating) connection of this sandbox. */
  isConnected(target: SandboxTarget): Promise<boolean>;
}

/** How a run ended, as the wire observed it. */
export type RunEnd =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: ErrorInfo }
  | { readonly status: "interrupted" };

/**
 * KOBE-30 seam: told after the wire ended a run (committed: status, thread status and terminal
 * event are already written). The orchestrator releases the thread lock and advances the queue.
 * Called on the replica that observed the end; failures are logged, never retried.
 */
export interface RunLifecycleHooks {
  onRunEnded?(event: {
    readonly teamId: string;
    readonly runId: string;
    readonly threadId: string;
    readonly status: Extract<RunStatus, "completed" | "failed" | "interrupted">;
  }): Promise<void> | void;
}

/** What the policy check needs to know about a run beyond the `runs`/`threads` rows. */
export interface RunPolicyContext {
  /** Effective approval mode (KOBE-30 `runs.approval_mode`); undefined → `ask-on-write` (D29). */
  readonly approvalMode?: ApprovalMode;
  /**
   * The loosest mode a run may use (install and team floor, the stricter of both). Required: when
   * it cannot be determined the call is denied.
   */
  readonly floor: ApprovalMode;
  /** Agent frontmatter `tools.allow` / `tools.deny` (KOBE-46/47 resolve the pinned version). */
  readonly toolsAllow?: readonly string[];
  readonly toolsDeny?: readonly string[];
  readonly projectId?: string;
}

/** KOBE-30/46/47 seam: run-specific policy inputs, read inside the team's transaction. */
export interface RunPolicyContextSource {
  load(
    tx: KobeTx,
    run: { readonly teamId: string; readonly runId: string; readonly threadId: string },
  ): Promise<RunPolicyContext>;
}

/** A `require_approval` decision waiting for a human (KOBE-37 implements the broker). */
export interface ApprovalRequest {
  readonly teamId: string;
  readonly userId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly decision: Extract<PolicyDecision, { effect: "require_approval" }>;
  /** Abort when the run or connection ends: resolve with a deny. */
  readonly signal: AbortSignal;
}

export type ApprovalOutcome =
  | {
      readonly decision: "allow";
      readonly reasons: readonly PolicyReason[];
      readonly approval?: ApprovalToken;
    }
  | {
      readonly decision: "deny";
      readonly reasons: readonly PolicyReason[];
      readonly message: string;
    };

/**
 * KOBE-37 seam: resolves `require_approval` (sign, show the card, wait). `onPending` sends
 * `policy.pending` to the sandbox. The default broker denies with a clear reason.
 */
export interface ApprovalBroker {
  request(
    request: ApprovalRequest,
    onPending: (pending: { readonly approvalId: string; readonly expiresAt: string }) => void,
  ): Promise<ApprovalOutcome>;
}

/** Pi extension dialogs (`pi.ui_request`). Kobe v1 has no UI for them; the default cancels. */
export interface UiBroker {
  /** Returns the response to send, or undefined for fire-and-forget methods. */
  handle(request: {
    readonly target: SandboxTarget;
    readonly threadId: string;
    readonly runId?: string;
    readonly request: PiExtensionUiRequest;
  }): Promise<PiExtensionUiResponse | undefined>;
}
