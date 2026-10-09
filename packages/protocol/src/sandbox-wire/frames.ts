import { z } from "zod";
import { approvalTokenSchema } from "../approval.js";
import {
  approvalModeSchema,
  errorInfoSchema,
  idSchema,
  SYSTEM_PROMPT_MAX_BYTES,
  timestampSchema,
  utf8ByteLength,
  uuidSchema,
} from "../common.js";
import { connectorNameSchema } from "../tools.js";
import { runTokenGrantSchema } from "../run-token.js";
import { SANDBOX_ERROR_CODES, SANDBOX_WIRE_VERSION } from "./connection.js";
import {
  memoryPutFrameSchema,
  memoryReadFrameSchema,
  memoryResultFrameSchema,
} from "./memory-frames.js";
import { runMemoryContextSchema } from "../memory.js";
import { UPLOAD_MAX_FILES_PER_MESSAGE, uploadFileNameSchema } from "../uploads.js";
import { artifactCallShape, artifactFailFields, artifactOkFields } from "../artifacts.js";
import { BUILTIN_SKILL_NAMES, SKILL_BUNDLES_MAX, skillBundleRefSchema } from "./skill-bundles.js";
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
/**
 * Forward compatibility (normative). After an upgrade the server is newer than the sandboxes still
 * running, so **server → sandbox informational enums are open**: a code the agent does not know
 * still decodes, as an opaque string of {@link OPEN_CODE_PATTERN} shape (reason codes and stages,
 * error codes, stop and shutdown reasons; extra keys in a reason are kept). The server may add
 * codes freely. **Decisions and modes stay closed** (`policy.result.decision`, `run.stop.mode`, Pi
 * config values): those change behaviour, so a new value is a wire version change. Sandbox →
 * server frames stay strict: the server is never older than the agents it talks to.
 */
export const OPEN_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const openCode = z.string().regex(OPEN_CODE_PATTERN);

/** A policy reason as the sandbox reads it: known shape, open code and stage. */
export const wirePolicyReasonSchema = z.looseObject({
  code: openCode,
  stage: openCode,
  message: z.string().max(1000),
  rule_id: uuidSchema.optional(),
});
export type WirePolicyReason = z.infer<typeof wirePolicyReasonSchema>;

const errorFields = {
  message: z.string().max(2000),
  /** The `command_id` / `request_id` / frame type the error refers to, if any. */
  ref: z.string().max(256).optional(),
};
/** Sandbox → server: closed codes. */
const errorFrame = frame("error", { code: z.enum(SANDBOX_ERROR_CODES), ...errorFields });
/** Server → sandbox: open codes ({@link SANDBOX_ERROR_CODES} today; newer servers may add some). */
const serverErrorFrame = frame("error", { code: openCode, ...errorFields });

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
  /**
   * Optional features this agent supports (KOBE-82), e.g. `skill_bundles`. Absent = none (older
   * agents). The server sends a feature's fields only to agents that list it. An agent that sends
   * this field needs a server that knows it: roll the server out first.
   */
  capabilities: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
    .max(32)
    .optional(),
});

/** One raw Pi session event, bridged unchanged (the server translates to Kobe events). */
export const piEventFrameSchema = frame("pi.event", {
  run_id: uuidSchema,
  thread_id: uuidSchema,
  seq,
  event: piSessionEventSchema,
});

/**
 * An `extension_ui_request` from Pi, forwarded for the server to answer or cancel. Not sequenced:
 * after a reconnect the agent re-sends every dialog still open, so the server must dedupe by
 * `(thread_id, request.id)` and answer each dialog once (KOBE-23/24).
 */
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
 * that mutates `event.input` (Pi lets `tool_call` handlers mutate input in place). It checks the
 * executed object as is — plain JSON only, so what it sends is what the tool reads — and
 * deep-freezes that object before asking, so the executed input is exactly the decided one. It
 * does not replace `event.input` (a re-parsed copy would be a no-op in Pi 1.0.0; KOBE-36).
 * Size: at most {@link SANDBOX_FRAME_MAX_BYTES_BY_TYPE}`["policy.check"]` (1 MiB) per frame — it
 * carries a `write`'s content as executed; a larger check closes the connection, so the sandbox
 * blocks such a call locally instead of sending it (kobe-policy caps the line it hands the agent at
 * 1 MiB − 4 KiB, leaving room for the frame envelope the agent adds; KOBE-36).
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

/**
 * Sandbox -> server (KOBE-127, artifacts.ts), behind hello capability `artifacts`: the
 * `create_artifact` / `update_artifact` call kobe-policy let through. The server answers with
 * `artifact.result` for the same `request_id`. At most 1 MiB (own entry in
 * {@link SANDBOX_FRAME_MAX_BYTES_BY_TYPE}); the server refuses it from a connection that did not
 * announce the capability and checks it against what it allowed for `tool_call_id` (KOBE-129).
 */
const artifactPutFields = {
  request_id: idSchema,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  tool_call_id: idSchema,
};
export const artifactPutFrameSchema = z.union([
  frame("artifact.put", { ...artifactPutFields, ...artifactCallShape.create }),
  frame("artifact.put", { ...artifactPutFields, ...artifactCallShape.update }),
]);

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
  artifactPutFrameSchema,
  memoryPutFrameSchema,
  memoryReadFrameSchema,
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
/**
 * API styles Pi 1.0.x speaks to the model gateway (KOBE-41), by the catalog provider's kind:
 * OpenAI, Ollama and OpenAI-compatible endpoints → `openai-completions` (`<gateway>/v1`),
 * Anthropic → `anthropic-messages` (`<gateway>/anthropic`), Gemini → `google-generative-ai`
 * (`<gateway>/genai/v1beta`). The agent builds the base URL from its own environment.
 */
export const PI_MODEL_APIS = [
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export const piModelApiSchema = z.enum(PI_MODEL_APIS);
export type PiModelApi = z.infer<typeof piModelApiSchema>;

/** `<gateway provider>/<model>` as the model gateway names models (KOBE-40 `gateway_model`). */
export const gatewayModelSchema = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

/**
 * Unknown keys are ignored (stripped), not rejected, since KOBE-82: a future additive field must not
 * break an older agent. Known fields stay strictly validated; the frame itself is still strict.
 */
export const piThreadConfigSchema = z.object({
  /**
   * The run's model (D30): the catalog alias plus, resolved by the server from the catalog
   * (KOBE-41), the gateway's model id and API style. Without `gateway_model` the sandbox has no
   * model to offer Pi (the run fails `model_not_configured`).
   */
  model: z
    .strictObject({
      alias: z.string().min(1).max(128),
      gateway_model: gatewayModelSchema.optional(),
      api: piModelApiSchema.optional(),
    })
    .optional(),
  thinking_level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  agent: z
    .strictObject({ agent_id: uuidSchema, version: z.number().int().positive() })
    .nullable()
    .optional(),
  /** At most `SYSTEM_PROMPT_MAX_BYTES` UTF-8 bytes: the same limit as the agent file's prompt. */
  system_prompt: z
    .string()
    .refine((s) => utf8ByteLength(s) <= SYSTEM_PROMPT_MAX_BYTES, {
      message: `system_prompt is over ${SYSTEM_PROMPT_MAX_BYTES} bytes`,
    })
    .optional(),
  /** Names of the run's effective skills (D22); the bytes are `skill_bundles`. */
  skills: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/))
    .max(64)
    .optional(),
  /**
   * The bytes behind `skills` (KOBE-82, skill-bundles.ts): the canonical zip's hash and size per
   * effective skill. The sandbox materializes exactly these and nothing else. Absent = none.
   */
  skill_bundles: z.array(skillBundleRefSchema).max(SKILL_BUNDLES_MAX).optional(),
  /**
   * Built-in skills baked into the sandbox image that this run's effective skills include
   * (KOBE-88, skill-bundles.ts). Registered with Pi from the image; nothing is fetched. Absent = none.
   */
  builtin_skills: z.array(z.enum(BUILTIN_SKILL_NAMES)).max(BUILTIN_SKILL_NAMES.length).optional(),
  /** Connectors to expose; Pi tool names become `mcp__<name>__<tool>` (verified Pi 1.0.0). */
  mcp_servers: z
    .array(z.strictObject({ name: connectorNameSchema, connector_id: uuidSchema }))
    .max(64)
    .optional(),
  approval_mode: approvalModeSchema.optional(),
});
export type PiThreadConfig = z.infer<typeof piThreadConfigSchema>;

/** One uploaded file as the agent sees it (`run.start.attachments`). */
export const sandboxAttachmentSchema = z.strictObject({
  /**
   * Absolute path of the synced file, normally `{@link UPLOAD_ATTACHMENT_ROOT}/<thread>/<name>`.
   * The schema only rejects `..` segments: the agent's workspace root is configurable and the agent
   * refuses paths outside it (`pi_rejected`), so the exact root is not part of the wire shape.
   */
  path: z
    .string()
    .min(1)
    .refine((p) => !p.split("/").includes(".."), "path traversal"),
  mime_type: z.string().min(1),
  /** Original file name, for the prompt; absent in frames from older servers. */
  name: uploadFileNameSchema.optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  /**
   * Hint that the model supports this media natively: the agent MAY pass the file to Pi as an
   * image / document block (read from `path`) in addition to listing it. Absent = text path only.
   */
  native_media: z.enum(["image", "pdf"]).optional(),
});
export type SandboxAttachment = z.infer<typeof sandboxAttachmentSchema>;

/** Start a run: spawn/reuse the thread's `pi --mode rpc` process and send Pi `prompt`. */
export const runStartFrameSchema = frame("run.start", {
  command_id: commandId,
  run_id: uuidSchema,
  thread_id: uuidSchema,
  message: z.string(),
  /**
   * Uploaded files already synced into the sandbox (KOBE-141, uploads.ts); absent = none. Older
   * servers send only `path` and `mime_type`.
   */
  attachments: z.array(sandboxAttachmentSchema).max(UPLOAD_MAX_FILES_PER_MESSAGE).optional(),
  /** Branch point for edit-and-regenerate; absent = continue from the thread's leaf. */
  parent_entry_id: idSchema.optional(),
  config: piThreadConfigSchema.optional(),
  /**
   * Run-bound model-gateway token (KOBE-117, run-token.ts): bound to this run, delivered to this
   * thread's Pi only (the agent must not write it to disk or env, nor expose it to tools), sent
   * as `x-kobe-run-token`. Sent only to agents whose `hello.capabilities` lists
   * `CAPABILITY_RUN_TOKEN`; absent = legacy (session token + advisory `x-kobe-run-id`).
   */
  run_token: runTokenGrantSchema.optional(),
  /** Memory indexes and enabled scopes (KOBE-153, memory.ts); only for agents with capability `memory`. */
  memory: runMemoryContextSchema.optional(),
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
  /** `user_cancelled` | `budget_exhausted` | `approval_expired` today; open (informational). */
  reason: openCode,
});

/**
 * Allow-listed Pi RPC command (`get_entries(since)`, `get_state`, `compact`, ...; never `fork`, see
 * pi-rpc.ts); answered with `command.result`.
 */
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
 * server-side first). `message` becomes Pi's block reason. `approval` (optional, present when the
 * allow came from a human approval) stops at kobe-sandbox-agent: the agent strips it before the
 * decision reaches kobe-policy (KOBE-23), so the token never enters Pi or a tool. For Pi built-ins
 * and kobe tools this frame is itself the authorisation; the MCP proxy finds the approval by
 * (run_id, tool_call_id) server-side (KOBE-58), not through the sandbox.
 */
export const policyResultFrameSchema = z.union([
  frame("policy.result", {
    request_id: idSchema,
    run_id: uuidSchema,
    tool_call_id: idSchema,
    decision: z.literal("allow"),
    reasons: z.array(wirePolicyReasonSchema).min(1),
    approval: approvalTokenSchema.optional(),
  }),
  frame("policy.result", {
    request_id: idSchema,
    run_id: uuidSchema,
    tool_call_id: idSchema,
    decision: z.literal("deny"),
    reasons: z.array(wirePolicyReasonSchema).min(1),
    message: z.string().max(2000),
  }),
]);

/**
 * Server -> sandbox answer to `artifact.put` (KOBE-127). `error.code` is open (known:
 * `ARTIFACT_ERROR_CODES`); the tool result handed to the model is this answer.
 */
export const artifactResultFrameSchema = z.union([
  frame("artifact.result", { request_id: idSchema, ...artifactOkFields }),
  frame("artifact.result", { request_id: idSchema, ...artifactFailFields }),
]);

/**
 * Rebuild a thread's Pi session JSONL from Postgres (volume lost, D13/D15). Sent in parts, each
 * its own command with its own `command_id`, and **every part gets its own `command.result`**
 * (the server sends the next part after the previous one's result). Part 0 starts (or restarts)
 * the restore and may carry `header` (absent → the agent writes a default one); the agent writes
 * the file only after `final: true`, and a lost connection voids a partial restore (the server
 * starts again from part 0). The agent **rewrites `header.cwd`** to its own workspace directory,
 * whatever the stored header says: Pi 1.0.0 refuses a session whose cwd does not exist.
 * SPECULATIVE chunking (KOBE-24 sends ≤ 2 MiB parts).
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

/** Gap on a live socket: re-send this run's `pi.event` frames from `from_seq` (= durable_seq + 1). */
export const resendFrameSchema = frame("resend", { run_id: uuidSchema, from_seq: seq });

/** Drain and close: abort nothing in flight unless `deadline_ms` passes. */
export const shutdownFrameSchema = frame("shutdown", {
  /** `hibernate` | `destroy` | `replaced` today; open (informational). */
  reason: openCode,
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
  artifactResultFrameSchema,
  memoryResultFrameSchema,
  sessionRestoreFrameSchema,
  ackFrameSchema,
  resendFrameSchema,
  shutdownFrameSchema,
  pingFrame,
  pongFrame,
  serverErrorFrame,
]);
export type ServerToSandboxFrame = z.infer<typeof serverToSandboxFrameSchema>;

export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type HelloAckFrame = z.infer<typeof helloAckFrameSchema>;
export type PiEventFrame = z.infer<typeof piEventFrameSchema>;
export type PolicyCheckFrame = z.infer<typeof policyCheckFrameSchema>;
export type ArtifactPutFrame = z.infer<typeof artifactPutFrameSchema>;
export type ArtifactResultFrame = z.infer<typeof artifactResultFrameSchema>;
export type PolicyResultFrame = z.infer<typeof policyResultFrameSchema>;
export type RunStartFrame = z.infer<typeof runStartFrameSchema>;
export type RunStopFrame = z.infer<typeof runStopFrameSchema>;
export type CommandResultFrame = z.infer<typeof commandResultFrameSchema>;
