import type {
  AppCardEntry,
  ApprovalMode,
  ApprovalToken,
  ErrorInfo,
  PiBridgeCommand,
  PiExtensionUiRequest,
  PiExtensionUiResponse,
  PiModelApi,
  PiThreadConfig,
  PolicyDecision,
  PolicyReason,
  RunProjectContext,
  RunMcpContext,
  RunStatus,
  RunViewingContext,
  SandboxAttachment,
  SealedReplyKey,
  SessionTokenClaims,
} from "@kobe/protocol";
import type { KobeTx } from "@kobe/db";

/**
 * The sandbox a connection is, or a command targets: the (team, user) member sandbox (D11), or,
 * with `evalThreadId`, the ephemeral sandbox of that skill-eval thread (KOBE-325; wire slot
 * `e-<thread>`, connection in `sandbox_eval_connections`). A command's sandbox always follows its
 * thread (`enqueueCommand`), whatever the caller passes.
 */
export interface SandboxTarget {
  readonly teamId: string;
  readonly userId: string;
  readonly evalThreadId?: string;
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
  isLive(claims: {
    sandboxId: string;
    teamId: string;
    userId: string;
    /** An eval sandbox (KOBE-325): live while it is claim `e-<thread>` and its execution runs. */
    evalThreadId?: string;
  }): Promise<boolean>;
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

/**
 * A wake that cannot succeed by waiting: no verified isolation runtime, an offboarded sandbox, a
 * pod that is not Ready within the wake timeout (`workspace_unavailable`, KOBE-192).
 */
export class SandboxWakeError extends Error {
  constructor(
    readonly code: "isolation_runtime_missing" | "sandbox_unavailable" | "workspace_unavailable",
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
  skillsUnsupported: "skills_unsupported", // run.start lists skills, the agent can't load them
  queuedBeforeUpgrade: "queued_before_upgrade", // run.start queued before KOBE-317 lists built-ins
  compactUnsupported: "compact_unsupported", // thread.compact to an agent without it or run tokens
  contextUnsupported: "context_unsupported", // thread.context to an agent without it (KOBE-470)
  kernelStartUnsupported: "kernel_start_unsupported", // notebook.restart op start, no notebook_start
} as const;

export interface RunStartRequest {
  readonly runId: string;
  readonly threadId: string;
  readonly message: string;
  readonly attachments?: readonly SandboxAttachment[];
  readonly parentEntryId?: string;
  readonly config?: PiThreadConfig;
  /** Project instructions (KOBE-161); dropped for agents without the `projects` capability. */
  readonly project?: RunProjectContext;
  /** Effective MCP connectors (KOBE-111); dropped for agents without the `mcp` capability. */
  readonly mcp?: RunMcpContext;
  /**
   * App cards Pi may not have yet, ending at `parentEntryId` (KOBE-440). An agent without the
   * `app_cards` capability gets none and starts below them instead.
   */
  readonly appCards?: readonly AppCardEntry[];
  /** The member's viewed file (KOBE-462); dropped for agents without the `file_edits` capability. */
  readonly viewing?: RunViewingContext;
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

/**
 * A compaction run's start (KOBE-213, `thread.compact`): delivered like `run.start` (entry sync or
 * restore first, lease and run token in the delivery transaction), answered by
 * `thread.compact_result`. Only to agents announcing `thread_compact` and `run_token`.
 */
export interface ThreadCompactRequest {
  readonly runId: string;
  readonly threadId: string;
  readonly focus?: string;
  readonly model: {
    readonly alias: string;
    readonly gateway_model: string;
    readonly api: PiModelApi;
  };
  readonly modelLimits?: { readonly max_output_tokens: number; readonly context_window: number };
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
  /**
   * KOBE-325, to a skill eval's own sandbox only (an eval thread): copy the case's fixtures in
   * (`eval.prepare`), or take the after-snapshot (`eval.snapshot`; `data` untrusted: validate it).
   */
  evalPrepare(
    target: SandboxTarget,
    request: {
      readonly threadId: string;
      readonly files: readonly { path: string; sha256: string; size: number }[];
    },
    options?: SendOptions,
  ): Promise<CommandOutcome>;
  evalSnapshot(
    target: SandboxTarget,
    request: {
      readonly threadId: string;
      readonly roots: readonly string[];
      readonly hashPaths: readonly string[];
    },
    options?: SendOptions,
  ): Promise<CommandOutcome>;
  /**
   * KOBE-326, to a skill eval's own sandbox only: the matched outputs' bytes for the judge
   * (`eval.read`; paths and walked sizes only go out; `data` untrusted: validate it).
   */
  evalRead(
    target: SandboxTarget,
    request: {
      readonly threadId: string;
      readonly files: readonly { path: string; size: number }[];
    },
    options?: SendOptions,
  ): Promise<CommandOutcome>;
  /**
   * KOBE-470, to the member's own sandbox only: the context of the thread's latest model call
   * (`thread.context`; on success `data` is `{sealed}`, the `ThreadContextResult` sealed to
   * `replyKey`: open it with the caller's private key, then validate it). The thread's session is
   * brought in line first (entry sync, or a restore after a wake).
   */
  threadContext(
    target: SandboxTarget,
    request: {
      readonly threadId: string;
      readonly maxBytes: number;
      readonly replyKey: SealedReplyKey;
    },
    options?: SendOptions,
  ): Promise<CommandOutcome>;
  /** `thread.compact`; on success `data` is the result in wire casing (untrusted: validate it). */
  compactThread(
    target: SandboxTarget,
    request: ThreadCompactRequest,
    options?: SendOptions,
  ): Promise<CommandOutcome>;
  /**
   * KOBE-464, the thread's kernel (docs/specs/notebooks.md): run code (`data` untrusted: a
   * `notebookExecuteResultSchema` to validate; the outputs arrive as run events meanwhile),
   * interrupt or restart, or start the kernel (KOBE-477: `notebook.restart` with `op: "start"`, only
   * to agents with `notebook_start`). Only to agents with capability `notebooks`.
   */
  notebookExecute(
    target: SandboxTarget,
    request: NotebookExecuteRequest,
    options?: SendOptions,
  ): Promise<CommandOutcome>;
  notebookKernel(
    target: SandboxTarget,
    request: { readonly threadId: string; readonly op: "interrupt" | "restart" | "start" },
    options?: SendOptions,
  ): Promise<CommandOutcome>;
  /**
   * Start waking the member's sandbox without sending it anything (KOBE-470: the context viewer
   * answers 202 while it wakes, then asks again). Rejects with the wake's error.
   */
  wake(target: SandboxTarget): Promise<void>;
  /** True while some replica holds a live (heartbeating) connection of this sandbox. */
  isConnected(target: SandboxTarget, threadId?: string): Promise<boolean>;
}

export interface NotebookExecuteRequest {
  readonly threadId: string;
  readonly runId: string;
  readonly execId: string;
  readonly code: string;
  readonly timeoutMs: number;
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
   * The loosest mode a run may use (site and team floor, the stricter of both). Required: when
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
  /**
   * The wire connection that asked (KOBE-37): an approval can only be decided while it is still
   * the sandbox's open connection, since only it can deliver the result.
   */
  readonly connectionId: string;
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
  /** Bus hint `apr:<id>`: the approval left `pending` (any replica); re-read it now. */
  onHint?(approvalId: string): void;
  /** Hints may have been missed (bus reconnected): re-read every approval being waited on. */
  onResync?(): void;
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
