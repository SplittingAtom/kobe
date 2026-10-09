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
import { approvalResolutionCauseSchema, policyReasonSchema } from "./policy.js";

/** Kobe Event Stream event types (spec §6.2). Every event is persisted to `run_events` with a monotonic `seq` before fan-out. */
export const KOBE_EVENT_TYPES = [
  "run.queued",
  "run.started",
  "sandbox.waking",
  "context.omitted",
  "text.delta",
  "reasoning.delta",
  "tool.call",
  "tool.result",
  "approval.requested",
  "approval.resolved",
  "policy.denied",
  "egress.blocked",
  "steer.applied",
  "memory.updated",
  "artifact.created",
  "artifact.updated",
  "file.shared",
  "entry.committed",
  "run.completed",
  "run.failed",
  "run.interrupted",
  "run.budget_stopped",
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
    /** The thread's pinned agent; both null = the install default agent (threads.agent_id null). */
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
  }),
  "run.failed": z.strictObject({
    error: errorInfoSchema,
  }),
  "run.interrupted": z.strictObject({
    /**
     * `sandbox_lost` → run status `interrupted` (Retry offered). `cancelled` → run status
     * `cancelled` (user Stop): §6.2 has no `run.cancelled` type, so Stop ends the stream here.
     */
    reason: z.enum(["sandbox_lost", "cancelled"]),
    last_entry_id: idSchema.nullable(),
    retryable: z.boolean(),
  }),
  "run.budget_stopped": z.strictObject({
    scope: z.enum(["install", "team", "user"]),
    message: z.string().max(1000),
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

/** Terminal events: the server closes the SSE stream after sending one. */
export const TERMINAL_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.interrupted",
  "run.budget_stopped",
] as const satisfies KobeEventType[];

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
