import { z } from "zod";
import {
  errorInfoSchema,
  idSchema,
  jsonValueSchema,
  riskClassSchema,
  runTriggerSchema,
  timestampSchema,
  toolInputSchema,
  usageSchema,
  uuidSchema,
} from "./common.js";
import { skippedActionsSchema } from "./notifications.js";
import {
  SEMVER_PATTERN as SKILL_SEMVER_PATTERN,
  SKILL_NAME_PATTERN,
} from "./skill-package/layout.js";
import { approvalResolutionCauseSchema, policyReasonSchema } from "./policy.js";
import { rememberScopeSchema } from "./remember.js";
import { fileEditProposedPayloadSchema } from "./file-editor.js";
import {
  notebookFinishedPayloadSchema,
  notebookOutputPayloadSchema,
  notebookStartedPayloadSchema,
} from "./notebooks.js";
import { thinkingLevelSchema } from "./thinking.js";
import {
  SERVER_CALL_PURPOSES,
  generatedTitleSchema,
  serverCallPurposeSchema,
  threadSuggestionsSchema,
} from "./server-call.js";

/** Kobe Event Stream event types (spec §6.2). Every event is persisted to `run_events` with a monotonic `seq` before fan-out. */
export const KOBE_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "sandbox.waking",
  "context.omitted",
  // KOBE-315 (CE12): skills whose version changed since the thread's previous run.
  "thread.skill_updated",
  "text.delta",
  "reasoning.delta",
  "tool.call",
  "tool.result",
  "approval.requested",
  "approval.resolved",
  "policy.denied",
  "policy.rule_applied",
  "egress.blocked",
  "steer.applied",
  "memory.updated",
  "artifact.created",
  "artifact.updated",
  "file.shared",
  // KOBE-442: the member's private Workbench draft `save_skill_draft` made or updated.
  "skill.draft_saved",
  // KOBE-462: a `propose_file_edit` proposal awaiting the member (file-editor.ts).
  "file.edit_proposed",
  // KOBE-464: a kernel execution (the member's `notebook` run or a `run_python` call; notebooks.ts).
  "notebook.started",
  "notebook.output",
  "notebook.finished",
  "entry.committed",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "run.budget_stopped",
  // Epilogue (KOBE-234): results of the server's post-run model calls, after `run.completed`.
  "thread.updated",
  "thread.suggestions",
] as const;

export type KobeEventType = (typeof KOBE_EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(KOBE_EVENT_TYPES);

export function isKobeEventType(value: unknown): value is KobeEventType {
  return typeof value === "string" && EVENT_TYPE_SET.has(value);
}

/**
 * Stream-local id of one assistant message while it streams. Pi 1.0.0 RPC does not expose the
 * session entry id until the entry is persisted (verified: `message_start`/`message_update`/
 * `message_end` carry no id), so deltas carry `message_id` and `entry.committed` binds it to the
 * durable `entry_id`. Unique within a run.
 */
const messageId = idSchema;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/** The `tool.result` `app` marker (KOBE-438, MCP Apps MA10). */
export const toolResultAppSchema = z.strictObject({
  connector_id: uuidSchema,
  /** SHA-256 of `connectorId:uri` (KOBE-436). */
  app_id: sha256Hex,
  /** The pinned template the result was captured for; another one renders as text. */
  template_sha256: sha256Hex,
  /** The `thread_app_results` row. */
  result_ref: uuidSchema,
});
export type ToolResultApp = z.infer<typeof toolResultAppSchema>;

/**
 * Size bounds (UTF-8 bytes of the JSON text), as the server already enforces them (KOBE-24/31):
 * a whole event payload at most {@link EVENT_PAYLOAD_MAX_BYTES} (bigger content lives in S3 by
 * `blob_ref`, D15); a `tool.call` input at most {@link EVENT_TOOL_INPUT_MAX_BYTES} (the server
 * replaces a larger one with `{kobe_omitted: "too_large", bytes}`); an `entry.committed` payload at
 * most {@link EVENT_ENTRY_PAYLOAD_MAX_BYTES} (larger entries are stored, not streamed: the field is
 * omitted and clients read the entry from the thread).
 */
export const EVENT_PAYLOAD_MAX_BYTES = 256 * 1024;
export const EVENT_TOOL_INPUT_MAX_BYTES = 64 * 1024;
export const EVENT_ENTRY_PAYLOAD_MAX_BYTES = 64 * 1024;

const utf8 = new TextEncoder();

/** UTF-8 bytes of `value` as JSON text (what `run_events.payload` and the SSE body carry). */
export function jsonByteLength(value: unknown): number {
  return utf8.encode(JSON.stringify(value) ?? "").length;
}

function withinBytes<T extends z.ZodType>(schema: T, max: number): T {
  return schema.refine((value) => jsonByteLength(value) <= max, {
    message: `over ${max} bytes as JSON`,
  }) as unknown as T;
}

/** `context.omitted` carries at most this many items (producers truncate). */
export const CONTEXT_OMITTED_MAX_ITEMS = 100;

const contextOmissionSchema = z.strictObject({
  kind: z.enum(["skill", "connector", "model"]),
  name: z.string().min(1).max(256),
  reason: z.enum([
    "agent_exclusive",
    "team_disabled",
    "blocklisted",
    "shadowed_by_agent",
    "not_team_enabled",
    "not_user_connected",
    "no_team_default",
    "not_approved",
    // KOBE-297: over the run.start cap (`SKILL_BUNDLES_MAX`); offered skills go first.
    "skill_limit",
    // KOBE-313: a rescan on a scanner rule-set change turned the version Block; pending review.
    "suspended",
    // KOBE-315 (SK27, SK31): an agent names a catalog skill the team has not installed; the
    // install's version was revoked (no other in its range); an earlier step loaded a skill of
    // the same name; the version's bundle is not stored on this server.
    "not_installed",
    "revoked",
    "shadowed",
    "unavailable",
  ]),
});

export type ContextOmission = z.infer<typeof contextOmissionSchema>;

/** Payload schema per event type. Unknown keys are rejected so producers can't drift silently. */
export const EVENT_PAYLOAD_SCHEMAS = {
  "run.queued": z.strictObject({
    thread_id: uuidSchema,
    trigger: runTriggerSchema,
    queue_pos: z.number().int().positive(),
    user_entry_id: idSchema.optional(),
  }),
  "run.started": z.strictObject({
    thread_id: uuidSchema,
    /** The thread's pinned agent; both null = the site default agent (threads.agent_id null). */
    agent_id: uuidSchema.nullable(),
    agent_version: z.number().int().positive().nullable(),
    /**
     * Builder test run (KOBE-85): `agent_version` is null and this is the revision of the draft the
     * run used, so the record shows exactly what ran. Absent for published versions.
     */
    draft_revision: z.number().int().positive().optional(),
    /** Model alias from the team catalog (D30), e.g. `smart`. */
    model: z.string().min(1).max(128).optional(),
    /**
     * Where `model` came from (KOBE-44): the agent's pin, the conversation's choice, or the team's
     * default. The agent's pin wins over the conversation's choice (user decision).
     */
    model_source: z.enum(["agent", "thread", "default"]).optional(),
    /**
     * The run's thinking level (KOBE-260): the conversation's choice or the model's default,
     * clamped to the site and team settings. Absent: the model has no thinking control.
     */
    thinking_level: thinkingLevelSchema.optional(),
    retry_of_run_id: uuidSchema.optional(),
  }),
  "sandbox.waking": z.strictObject({
    /** `hibernated` resume, `first_start` (first-ever sandbox), `rebuild` (volume lost, D15). */
    reason: z.enum(["hibernated", "first_start", "rebuild"]),
  }),
  "text.delta": z.strictObject({
    message_id: messageId,
    content_index: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  "reasoning.delta": z.strictObject({
    message_id: messageId,
    content_index: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  "tool.call": z.strictObject({
    tool_call_id: idSchema,
    parent_tool_call_id: idSchema.optional(),
    message_id: messageId.optional(),
    tool: z.string().min(1).max(256),
    input: withinBytes(toolInputSchema, EVENT_TOOL_INPUT_MAX_BYTES),
    risk: riskClassSchema,
  }),
  "tool.result": z.strictObject({
    tool_call_id: idSchema,
    tool: z.string().min(1).max(256),
    is_error: z.boolean(),
    /** Text preview of the result; full output over 64 KB lives in S3 at `blob_ref` (D15). */
    preview: z.string().max(65_536),
    blob_ref: z.string().min(1).max(1024).optional(),
    truncated: z.boolean(),
    /**
     * MCP Apps (KOBE-438, spec MA10): the call's tool opens a pinned `ui://` template, and the
     * upstream's full result was stored from mcp-proxy's report (never from the sandbox). Set by
     * the server only; the card renders the app from `result_ref`
     * (`GET /v1/threads/{threadId}/app-results/{result_ref}`) and falls back to `preview`.
     */
    app: toolResultAppSchema.optional(),
  }),
  "approval.requested": z.strictObject({
    approval_id: uuidSchema,
    tool_call_id: idSchema,
    tool: z.string().min(1).max(256),
    input: toolInputSchema,
    risk: riskClassSchema,
    reasons: z.array(policyReasonSchema).min(1),
    expires_at: timestampSchema,
  }),
  "approval.resolved": z.strictObject({
    approval_id: uuidSchema,
    tool_call_id: idSchema,
    decision: z.enum(["allowed", "denied", "expired"]),
    /** `user` for allowed/denied; otherwise why it expired (ttl, or the run ended first). */
    cause: approvalResolutionCauseSchema,
    decided_by: uuidSchema.optional(),
    /** A remember-rule (`tool_rules` row) was written with this decision. */
    remembered: z.boolean(),
  }),
  "policy.denied": z.strictObject({
    tool_call_id: idSchema,
    tool: z.string().min(1).max(256),
    reasons: z.array(policyReasonSchema).min(1),
  }),
  /**
   * A call ran without asking because one of the member's remembered approvals allowed it
   * (KOBE-289): the tool card says "Allowed by your rule (<scope>)". Never the input.
   */
  "policy.rule_applied": z.strictObject({
    tool_call_id: idSchema,
    tool: z.string().min(1).max(256),
    rule_id: uuidSchema,
    scope: rememberScopeSchema,
  }),
  "context.omitted": z.strictObject({
    /**
     * What the run-start resolver left out of this run's effective set (KOBE-77), so the chat can
     * say so. Emitted once, right after `run.started`, only when something was omitted. Names are
     * the agent's own or the owner's personal items; never another team's. Additive: clients that
     * predate it ignore the event.
     */
    items: z.array(contextOmissionSchema).min(1).max(CONTEXT_OMITTED_MAX_ITEMS),
  }),
  "egress.blocked": z.strictObject({
    domain: z.string().min(1).max(253),
    /** The egress proxy sees connections, not tool calls; set only when the server can correlate. */
    tool_call_id: idSchema.optional(),
    /** Whether the "Request access" action is offered (false when the domain is outside the ceiling). */
    request_access: z.boolean(),
  }),
  "steer.applied": z.strictObject({
    /** The user entry Pi recorded for the steering message. */
    entry_id: idSchema.optional(),
    content: z.string(),
  }),
  "memory.updated": z.strictObject({
    scope: z.enum(["user", "project"]),
    memory_doc_id: uuidSchema,
    path: z.string().min(1).max(1024),
    version: z.number().int().positive(),
    /** Version to restore for Undo (D24); absent when the doc was created. */
    previous_version: z.number().int().positive().optional(),
    /** Correlates with the `remember` tool call (KOBE-153); absent on older events. */
    tool_call_id: idSchema.optional(),
    mode: z.enum(["replace", "append"]).optional(),
  }),
  "artifact.created": z.strictObject({
    artifact_id: uuidSchema,
    tool_call_id: idSchema.optional(),
    kind: z.enum(["html", "svg", "markdown", "mermaid", "code", "csv"]),
    title: z.string().max(512),
    version: z.literal(1),
  }),
  "artifact.updated": z.strictObject({
    artifact_id: uuidSchema,
    tool_call_id: idSchema.optional(),
    title: z.string().max(512).optional(),
    version: z.number().int().min(2),
  }),
  "file.shared": z.strictObject({
    file_id: uuidSchema,
    tool_call_id: idSchema.optional(),
    name: z.string().min(1).max(1024),
    size: z.number().int().nonnegative(),
    mime_type: z.string().max(255).optional(),
    /** `share_file` description (KOBE-147); absent in older events. */
    description: z.string().min(1).max(500).optional(),
  }),
  "skill.draft_saved": z.strictObject({
    tool_call_id: idSchema,
    draft_id: uuidSchema,
    name: z.string().regex(SKILL_NAME_PATTERN),
    /** False: the conversation's draft was updated (a new revision). */
    created: z.boolean(),
    /** A new draft although the conversation had one: it was shared, or edited since. */
    new_because: z.enum(["shared", "edited"]).optional(),
  }),
  /**
   * The server's record of a `propose_file_edit` proposal (KOBE-462): nothing was written; the
   * member reviews `content` against the file at `base_sha256` and commits through the save route.
   */
  "file.edit_proposed": fileEditProposedPayloadSchema,
  /** KOBE-464 (notebooks.ts, docs/specs/notebooks.md NB15). */
  "notebook.started": notebookStartedPayloadSchema,
  "notebook.output": notebookOutputPayloadSchema,
  "notebook.finished": notebookFinishedPayloadSchema,
  "entry.committed": z.strictObject({
    entry_id: idSchema,
    parent_id: idSchema.nullable(),
    /** Pi session entry type (`message`, `compaction`, `context_edit`, `branch_summary`, ...). */
    entry_type: z.string().min(1).max(64),
    /** Present when the entry finalises a streamed message. */
    message_id: messageId.optional(),
    /**
     * The Pi entry as stored in `thread_entries.payload`; omitted when it is over
     * {@link EVENT_ENTRY_PAYLOAD_MAX_BYTES} or stored by `blob_ref`.
     */
    payload: withinBytes(jsonValueSchema, EVENT_ENTRY_PAYLOAD_MAX_BYTES).optional(),
  }),
  "run.completed": z.strictObject({
    leaf_entry_id: idSchema.nullable(),
    usage: usageSchema.optional(),
    /** Scheduled runs (D32): tool calls denied instead of asked. Names only, never inputs (KOBE-176). */
    skipped_actions: skippedActionsSchema.optional(),
    /**
     * Server calls the server will make for this run (KOBE-234, server-call.ts): their results
     * follow as `thread.updated` / `thread.suggestions`, and the stream stays open for them (sse.ts).
     * Absent: none; the stream ends here.
     */
    epilogue: z
      .array(serverCallPurposeSchema)
      .min(1)
      .max(SERVER_CALL_PURPOSES.length)
      .refine((a) => new Set(a).size === a.length, { message: "duplicate epilogue entry" })
      .optional(),
  }),
  "run.failed": z.strictObject({
    error: errorInfoSchema,
    skipped_actions: skippedActionsSchema.optional(),
  }),
  "run.interrupted": z.strictObject({
    /**
     * `sandbox_lost` → run status `interrupted` (Retry offered). `cancelled` → run status
     * `cancelled` (user Stop): §6.2 has no `run.cancelled` type, so Stop ends the stream here.
     */
    reason: z.enum(["sandbox_lost", "cancelled"]),
    last_entry_id: idSchema.nullable(),
    retryable: z.boolean(),
    skipped_actions: skippedActionsSchema.optional(),
  }),
  "run.budget_stopped": z.strictObject({
    /** `install`: recorded before KOBE-256 renamed the scope; read it as `site`. Never sent now. */
    scope: z.enum(["site", "team", "user", "install"]),
    message: z.string().max(1000),
  }),
  /**
   * CE12 (KOBE-315): right after `run.started`, the skills this run loads at a different version
   * than the thread's previous run did ("Skill updated: xlsx 1.4.2 → 1.4.3"). Names and versions
   * only.
   */
  "thread.skill_updated": z.strictObject({
    thread_id: uuidSchema,
    skills: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(64),
          from: z.string().regex(SKILL_SEMVER_PATTERN),
          to: z.string().regex(SKILL_SEMVER_PATTERN),
        }),
      )
      .min(1)
      .max(64),
  }),
  /** CE18: the server titled the thread after its first run (never when `title_locked`). */
  "thread.updated": z.strictObject({
    thread_id: uuidSchema,
    title: generatedTitleSchema,
  }),
  /** CE21: follow-ups for the composer, shown until the next send. */
  "thread.suggestions": z.strictObject({
    thread_id: uuidSchema,
    suggestions: threadSuggestionsSchema,
  }),
} as const satisfies Record<KobeEventType, z.ZodType>;

export type KobeEventPayload<T extends KobeEventType> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;

/**
 * Envelope of every event: the `run_events` row and the SSE `data:` body.
 * `seq` is per run, starts at 1, gapless and monotonic: assigned by the `run_events` trigger
 * (KOBE-29; writers omit it) and committed in seq order. Consumers still drop `seq <= last seen`
 * (duplicates across reconnects).
 */
export type KobeEvent<T extends KobeEventType = KobeEventType> = {
  [K in T]: {
    run_id: string;
    seq: number;
    ts: string;
    type: K;
    payload: KobeEventPayload<K>;
  };
}[T];

function envelopeFor<T extends KobeEventType>(type: T) {
  return z.strictObject({
    run_id: uuidSchema,
    seq: z.number().int().positive(),
    ts: timestampSchema,
    type: z.literal(type),
    payload: EVENT_PAYLOAD_SCHEMAS[type],
  });
}

const envelopeSchemas = KOBE_EVENT_TYPES.map((type) => envelopeFor(type));

export const kobeEventSchema = z.discriminatedUnion(
  "type",
  envelopeSchemas as unknown as [
    ReturnType<typeof envelopeFor>,
    ...ReturnType<typeof envelopeFor>[],
  ],
) as unknown as z.ZodType<KobeEvent>;

/**
 * Terminal events: the server closes the SSE stream after sending one, unless `run.completed`
 * announces an `epilogue` ({@link EPILOGUE_EVENT_TYPES}, sse.ts). A terminal event still ends the
 * run: nothing after it changes the run's state.
 */
export const TERMINAL_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.interrupted",
  "run.budget_stopped",
] as const satisfies KobeEventType[];

/**
 * Events that may follow `run.completed` (KOBE-234): written by the server's post-run calls. After
 * a terminal event a run takes only these, only those its `run.completed.epilogue` announced, each
 * at most once per run, within `SERVER_CALL_EPILOGUE_MAX_MS`; anything else is refused (the
 * server's append guard). Never before the terminal event.
 */
export const EPILOGUE_EVENT_TYPES = {
  title: "thread.updated",
  followups: "thread.suggestions",
} as const satisfies Record<(typeof SERVER_CALL_PURPOSES)[number], KobeEventType>;

export function isTerminalEventType(type: KobeEventType): boolean {
  return (TERMINAL_EVENT_TYPES as readonly KobeEventType[]).includes(type);
}

/**
 * Validate a payload for a known type (producers call this before writing `run_events`),
 * including the whole-payload bound {@link EVENT_PAYLOAD_MAX_BYTES}.
 */
export function parseEventPayload<T extends KobeEventType>(
  type: T,
  payload: unknown,
): KobeEventPayload<T> {
  const parsed = EVENT_PAYLOAD_SCHEMAS[type].parse(payload) as KobeEventPayload<T>;
  if (jsonByteLength(parsed) > EVENT_PAYLOAD_MAX_BYTES) throw new EventPayloadTooLargeError(type);
  return parsed;
}

/** `parseEventPayload`: the payload is valid but over {@link EVENT_PAYLOAD_MAX_BYTES}. */
export class EventPayloadTooLargeError extends RangeError {
  constructor(readonly type: KobeEventType) {
    super(`${type} payload over ${EVENT_PAYLOAD_MAX_BYTES} bytes as JSON`);
    this.name = "EventPayloadTooLargeError";
  }
}
