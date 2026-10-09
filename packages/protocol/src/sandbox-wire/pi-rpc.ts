import { z } from "zod";

/**
 * Pi 1.0.x RPC records as bridged over the sandbox wire. VERIFIED against the published
 * `@earendil-works/pi-coding-agent@1.0.0` tarball (docs/rpc.md, rpc-commands.md, json.md,
 * rpc-extension-ui.md, dist/modes/rpc/rpc-types.d.ts):
 *
 * - `pi --mode rpc`: strict JSONL on stdin/stdout, split on LF only (Node `readline` is unsafe: it
 *   also splits on U+2028/U+2029). Commands carry an optional `id`; responses repeat it as
 *   `{type:"response", command, success, data? | error}`. Malformed input yields
 *   `{type:"response", command:"parse", success:false}` with no id.
 * - Session events (`agent_start`, `message_update`, `tool_execution_end`, `agent_settled`, ...)
 *   carry no command id. `agent_settled` (not `agent_end`) means Pi has no more automatic work.
 * - Extension UI is a sub-protocol: `extension_ui_request` (stdout) / `extension_ui_response` (stdin).
 *
 * Schemas here validate the envelope (`type`, discriminators, ids) and pass the rest through
 * (`looseObject`), so a Pi 1.0.x patch adding fields does not break the bridge. Only the commands
 * the server may issue are admitted (no `bash`, `switch_session`, `export_html`, `fork`, ...).
 * `fork` is excluded because it moves Pi to a new session file with fresh history (verified 1.0.0),
 * which would split the thread from the session file Kobe mirrors; edit-and-regenerate branches
 * with `run.start.parent_entry_id` instead (KOBE-23 refused it before the contract dropped it).
 */
export const PI_PINNED_VERSION = "1.0.0";

const piId = z.string().min(1).max(256);
const imageContent = z.looseObject({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});

/** Commands the server may send through `pi.command` (prompt/steer/abort go via `run.*` frames). */
export const piBridgeCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ id: piId, type: z.literal("get_state") }),
  z.strictObject({ id: piId, type: z.literal("get_entries"), since: z.string().optional() }),
  z.strictObject({ id: piId, type: z.literal("get_tree") }),
  z.strictObject({ id: piId, type: z.literal("get_session_stats") }),
  z.strictObject({ id: piId, type: z.literal("get_fork_messages") }),
  z.strictObject({ id: piId, type: z.literal("clear_queue") }),
  z.strictObject({
    id: piId,
    type: z.literal("compact"),
    customInstructions: z.string().optional(),
  }),
  // No `set_model` (KOBE-169): it resolves the model from Pi's catalog, which re-reads the
  // writable agent/ config (KOBE-165). A thread's model choice goes through `run.start`
  // (config.model, applied by kobe-models), never through a pi.command.
  z.strictObject({
    id: piId,
    type: z.literal("set_thinking_level"),
    level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  }),
  z.strictObject({ id: piId, type: z.literal("set_session_name"), name: z.string() }),
]);
export type PiBridgeCommand = z.infer<typeof piBridgeCommandSchema>;

/** The `prompt` / `steer` / `follow_up` command shapes kobe-sandbox-agent writes to Pi itself. */
export const piPromptCommandSchema = z.strictObject({
  id: piId.optional(),
  type: z.enum(["prompt", "steer", "follow_up"]),
  message: z.string(),
  images: z.array(imageContent).optional(),
  /** `prompt` only: required while Pi is streaming, else Pi rejects the command. */
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
});
export type PiPromptCommand = z.infer<typeof piPromptCommandSchema>;

/** Any Pi RPC response. `data` is command-specific and passed through. */
export const piRpcResponseSchema = z.union([
  z.looseObject({
    id: z.string().optional(),
    type: z.literal("response"),
    command: z.string(),
    success: z.literal(true),
    data: z.unknown().optional(),
  }),
  z.looseObject({
    id: z.string().optional(),
    type: z.literal("response"),
    command: z.string(),
    success: z.literal(false),
    error: z.string(),
  }),
]);
export type PiRpcResponse = z.infer<typeof piRpcResponseSchema>;

/** Session event types Pi 1.0.0 emits in RPC mode (json.md + RPC-only events). */
export const PI_SESSION_EVENT_TYPES = [
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
  "extension_error",
] as const;

/**
 * A Pi session event. Known types are listed above; unknown types are still forwarded (a 1.0.x
 * patch may add one) and the server ignores what it does not understand.
 */
export const piSessionEventSchema = z.looseObject({
  type: z.string().min(1).max(64),
});
export type PiSessionEvent = z.infer<typeof piSessionEventSchema>;

export const piExtensionUiRequestSchema = z.looseObject({
  type: z.literal("extension_ui_request"),
  id: piId,
  method: z.enum([
    "select",
    "confirm",
    "input",
    "editor",
    "notify",
    "setStatus",
    "setWidget",
    "setTitle",
    "set_editor_text",
  ]),
});
export type PiExtensionUiRequest = z.infer<typeof piExtensionUiRequestSchema>;

export const piExtensionUiResponseSchema = z.union([
  z.strictObject({ type: z.literal("extension_ui_response"), id: piId, value: z.string() }),
  z.strictObject({ type: z.literal("extension_ui_response"), id: piId, confirmed: z.boolean() }),
  z.strictObject({
    type: z.literal("extension_ui_response"),
    id: piId,
    cancelled: z.literal(true),
  }),
]);
export type PiExtensionUiResponse = z.infer<typeof piExtensionUiResponseSchema>;

/** A Pi session entry (session format v3) as returned by `get_entries`; mirrored into `thread_entries`. */
export const piSessionEntrySchema = z.looseObject({
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
  parentId: z.string().min(1).max(128).nullable(),
  timestamp: z.string(),
});
export type PiSessionEntry = z.infer<typeof piSessionEntrySchema>;

/** Pi session file header (first JSONL line; not part of the entry tree). */
export const piSessionHeaderSchema = z.looseObject({
  type: z.literal("session"),
  version: z.literal(3),
  id: z.string().min(1),
  timestamp: z.string(),
  cwd: z.string(),
});
export type PiSessionHeader = z.infer<typeof piSessionHeaderSchema>;
