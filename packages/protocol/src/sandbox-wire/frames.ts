import { z } from "zod";
import { approvalTokenSchema } from "../approval.js";
import {
  approvalModeSchema,
  errorInfoSchema,
  idSchema,
  timestampSchema,
  uuidSchema,
} from "../common.js";
import { policyReasonSchema } from "../policy.js";
import { SANDBOX_ERROR_CODES, SANDBOX_WIRE_VERSION } from "./connection.js";
import {
  piBridgeCommandSchema,
  piExtensionUiRequestSchema,
  piExtensionUiResponseSchema,
  piSessionEntrySchema,
  piSessionEventSchema,
  piSessionHeaderSchema,
} from "./pi-rpc.js";

/** Frame schemas for both directions. Semantics are documented in connection.ts. */

const v = z.literal(SANDBOX_WIRE_VERSION);
const seq = z.number().int().positive();
const nonce = z.string().min(1).max(64);
const commandId = idSchema;

function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ v, type: z.literal(type), ...shape });
}

const pingFrame = frame("ping", { nonce });
const pongFrame = frame("pong", { nonce });
const errorFrame = frame("error", {
  code: z.enum(SANDBOX_ERROR_CODES),
  message: z.string().max(2000),
  /** The `command_id` / `request_id` / frame type the error refers to, if any. */
  ref: z.string().max(256).optional(),
});

// ----------------------------------------------------------------------------- sandbox → server

export const helloFrameSchema = frame("hello", {
  sandbox_id: uuidSchema,
  agent_version: z.string().min(1).max(64),
  /** Installed Pi version; the server refuses (close `unsupported_version`) outside 1.0.x. */
  pi_version: z.string().min(1).max(64),
  /** Runs this agent still has a live Pi process for, with the highest outbound seq sent. */
  runs: z.array(
    z.strictObject({
      run_id: uuidSchema,
      thread_id: uuidSchema,
      last_seq: z.number().int().nonnegative(),
    }),
  ),
});

/** One raw Pi session event, bridged unchanged (the server translates to Kobe events). */
export const piEventFrameSchema = frame("pi.event", {
  run_id: uuidSchema,
  thread_id: uuidSchema,
  seq,
  event: piSessionEventSchema,
});

/** An `extension_ui_request` from Pi, forwarded for the server to answer or cancel. */
export const piUiRequestFrameSchema = frame("pi.ui_request", {
  run_id: uuidSchema.optional(),
  thread_id: uuidSchema,
  request: piExtensionUiRequestSchema,
});

/**
 * kobe-policy (Pi `tool_call` handler, verified in Pi 1.0.0: it may block with `{block, reason}`)
 * asks the server about one call. The extension blocks the call until `policy.result` arrives; a
 * lost connection or any error means block (fail closed). Parallel tool calls each get their own
 * `request_id`. `input` is the input as it will execute: kobe-policy must run after every handler
 * that mutates `event.input` (Pi lets `tool_call` handlers mutate input in place), and on allow it
 * replaces `event.input` with `JSON.parse(canonicalJson(input))` so the executed input is exactly
 * the decided one.
 */
export const policyCheckFrameSchema = frame("policy.check", {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
  parent_tool_call_id: idSchema.optional(),
  /**
   * Tool name only. Source, annotations and risk are derived by the server from its own registry
   * (tools.ts); anything else the sandbox might claim about a tool is not part of the frame.
   */
  tool: z.string().min(1).max(256),
  /** Must pass `toolInputSchema`; a failing input is a `deny` (`invalid_input`), not a frame error. */
  input: z.record(z.string(), z.json()),
});

/** Exactly one per server command. `data` is the Pi response `data` for `pi.command`. */
export const commandResultFrameSchema = z.union([
  frame("command.result", {
    command_id: commandId,
    ok: z.literal(true),
    data: z.unknown().optional(),
  }),
  frame("command.result", { command_id: commandId, ok: z.literal(false), error: errorInfoSchema }),
]);

/** A thread's Pi process exited (crash or after shutdown). Active runs on it are lost. */
export const piExitedFrameSchema = frame("pi.exited", {
  thread_id: uuidSchema,
  exit_code: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
  /** Last stderr lines for diagnostics. Must not contain secrets (there are none in the sandbox). */
  stderr_tail: z.string().max(8192),
});

export const sandboxToServerFrameSchema = z.union([
  helloFrameSchema,
  piEventFrameSchema,
  piUiRequestFrameSchema,
  policyCheckFrameSchema,
  commandResultFrameSchema,
  piExitedFrameSchema,
  pingFrame,
  pongFrame,
  errorFrame,
]);
export type SandboxToServerFrame = z.infer<typeof sandboxToServerFrameSchema>;

// ----------------------------------------------------------------------------- server → sandbox

export const helloAckFrameSchema = frame("hello.ack", {
  connection_id: idSchema,
  server_time: timestampSchema,
  heartbeat_interval_ms: z.number().int().positive(),
  /** Server's last durable outbound seq per run the server still considers active on this sandbox. */
  runs: z.array(
    z.strictObject({
      run_id: uuidSchema,
      thread_id: uuidSchema,
      durable_seq: z.number().int().nonnegative(),
    }),
  ),
});

/**
 * How the agent configures a thread's Pi process. SPECULATIVE values (owned by KOBE-41 model wiring,
 * KOBE-47 agent resolution, KOBE-62 MCP wiring); the shape is strict and carries **no URLs and no
 * credentials**: the model gateway and MCP proxy base URLs come from the sandbox's environment
 * (Helm), and the agent builds `<KOBE_MCP_PROXY_URL>/v1/mcp/<connector_id>` itself, so a server bug
 * or a forged frame cannot point Pi at an arbitrary endpoint.
 */
export const piThreadConfigSchema = z.strictObject({
  /** Model alias from the team catalog, served by the Bifrost gateway (D30). */
  model: z.strictObject({ alias: z.string().min(1).max(128) }).optional(),
  thinking_level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  agent: z
    .strictObject({ agent_id: uuidSchema, version: z.number().int().positive() })
    .nullable()
    .optional(),
  system_prompt: z.string().max(100_000).optional(),
  /** Skill directory names under /opt/kobe/skills or the user's skills dir (D22). */
  skills: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/))
    .max(64)
    .optional(),
  /** Connectors to expose; Pi tool names become `mcp__<name>__<tool>` (verified Pi 1.0.0). */
  mcp_servers: z
    .array(
      z.strictObject({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), connector_id: uuidSchema }),
    )
    .max(64)
    .optional(),
  approval_mode: approvalModeSchema.optional(),
});
export type PiThreadConfig = z.infer<typeof piThreadConfigSchema>;

/** Start a run: spawn/reuse the thread's `pi --mode rpc` process and send Pi `prompt`. */
export const runStartFrameSchema = frame("run.start", {
  command_id: commandId,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  message: z.string(),
  /** Workspace paths of attachments already synced to /workspace/uploads (SPECULATIVE, KOBE-53). */
  attachments: z
    .array(z.strictObject({ path: z.string().min(1), mime_type: z.string().min(1) }))
    .optional(),
  /** Branch point for edit-and-regenerate; absent = continue from the thread's leaf. */
  parent_entry_id: idSchema.optional(),
  config: piThreadConfigSchema.optional(),
});

/** Pi `steer`: delivered after the current turn's tool calls, before the next model call. */
export const runSteerFrameSchema = frame("run.steer", {
  command_id: commandId,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  message: z.string().min(1),
});

/**
 * `abort` = Pi `abort` now (Stop). `after_step` = let the in-flight model step and its tool calls
 * finish (`turn_end`), then abort (D30 budget stop).
 */
export const runStopFrameSchema = frame("run.stop", {
  command_id: commandId,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  mode: z.enum(["abort", "after_step"]),
  reason: z.enum(["user_cancelled", "budget_exhausted", "approval_expired"]),
});

/** Allow-listed Pi RPC command (get_entries(since), fork, ...); answered with `command.result`. */
export const piCommandFrameSchema = frame("pi.command", {
  command_id: commandId,
  thread_id: uuidSchema,
  command: piBridgeCommandSchema,
});

export const piUiResponseFrameSchema = frame("pi.ui_response", {
  thread_id: uuidSchema,
  response: piExtensionUiResponseSchema,
});

/** The call needs a human; the extension keeps waiting (up to `expires_at`). Informational. */
export const policyPendingFrameSchema = frame("policy.pending", {
  request_id: idSchema,
  run_id: uuidSchema,
  tool_call_id: idSchema,
  approval_id: uuidSchema,
  expires_at: timestampSchema,
});

/**
 * The server's decision. Only `allow` / `deny` reach the sandbox (`require_approval` is resolved
 * server-side first). `approval` is present when the allow came from a human approval; kobe-policy
 * passes it on where a downstream verifier (MCP proxy) needs it. `message` becomes Pi's block reason.
 */
export const policyResultFrameSchema = z.union([
  frame("policy.result", {
    request_id: idSchema,
    run_id: uuidSchema,
    tool_call_id: idSchema,
    decision: z.literal("allow"),
    reasons: z.array(policyReasonSchema).min(1),
    approval: approvalTokenSchema.optional(),
  }),
  frame("policy.result", {
    request_id: idSchema,
    run_id: uuidSchema,
    tool_call_id: idSchema,
    decision: z.literal("deny"),
    reasons: z.array(policyReasonSchema).min(1),
    message: z.string().max(2000),
  }),
]);

/**
 * Rebuild a thread's Pi session JSONL from Postgres (volume lost, D13/D15). Sent in parts; the agent
 * writes the file only after `final: true`, then answers `command.result`. SPECULATIVE chunking.
 */
export const sessionRestoreFrameSchema = frame("session.restore", {
  command_id: commandId,
  thread_id: uuidSchema,
  part: z.number().int().nonnegative(),
  final: z.boolean(),
  header: piSessionHeaderSchema.optional(),
  entries: z.array(piSessionEntrySchema),
});

/** Cumulative ack: every `pi.event` of `run_id` with seq ≤ `seq` is durable. */
export const ackFrameSchema = frame("ack", { run_id: uuidSchema, seq });

/** Drain and close: abort nothing in flight unless `deadline_ms` passes. */
export const shutdownFrameSchema = frame("shutdown", {
  reason: z.enum(["hibernate", "destroy", "replaced"]),
  deadline_ms: z.number().int().nonnegative(),
});

export const serverToSandboxFrameSchema = z.union([
  helloAckFrameSchema,
  runStartFrameSchema,
  runSteerFrameSchema,
  runStopFrameSchema,
  piCommandFrameSchema,
  piUiResponseFrameSchema,
  policyPendingFrameSchema,
  policyResultFrameSchema,
  sessionRestoreFrameSchema,
  ackFrameSchema,
  shutdownFrameSchema,
  pingFrame,
  pongFrame,
  errorFrame,
]);
export type ServerToSandboxFrame = z.infer<typeof serverToSandboxFrameSchema>;

export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type HelloAckFrame = z.infer<typeof helloAckFrameSchema>;
export type PiEventFrame = z.infer<typeof piEventFrameSchema>;
export type PolicyCheckFrame = z.infer<typeof policyCheckFrameSchema>;
export type PolicyResultFrame = z.infer<typeof policyResultFrameSchema>;
export type RunStartFrame = z.infer<typeof runStartFrameSchema>;
export type RunStopFrame = z.infer<typeof runStopFrameSchema>;
export type CommandResultFrame = z.infer<typeof commandResultFrameSchema>;
