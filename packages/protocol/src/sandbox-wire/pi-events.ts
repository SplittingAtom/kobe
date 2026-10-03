import { z } from "zod";
import { piSessionEntrySchema } from "./pi-rpc.js";

/**
 * Narrow schemas for the Pi 1.0.0 session events the server TRANSLATES into Kobe events (verified
 * against docs/json.md in the 1.0.0 tarball). The server validates a bridged `pi.event` with
 * `parseTranslatedPiEvent` before reading any field: a known type that fails its schema is an
 * `error` `malformed_frame` (the frame is dropped, the run keeps going); unknown types are ignored
 * (including the agent's {@link KOBE_EVENT_DROPPED_TYPE} placeholder).
 * Objects stay loose (a Pi 1.0.x patch may add fields); the fields Kobe reads are required.
 */

const contentIndex = z.number().int().nonnegative();
const nonEmpty = z.string().min(1).max(256);

/** Pi `Usage` (cost in USD). */
export const piUsageSchema = z.looseObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  cost: z.looseObject({ total: z.number().nonnegative() }),
});

const assistantMessageEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("start") }),
  z.looseObject({ type: z.literal("text_start"), contentIndex }),
  z.looseObject({ type: z.literal("text_delta"), contentIndex, delta: z.string() }),
  z.looseObject({ type: z.literal("text_end"), contentIndex, content: z.string() }),
  z.looseObject({ type: z.literal("thinking_start"), contentIndex }),
  z.looseObject({ type: z.literal("thinking_delta"), contentIndex, delta: z.string() }),
  z.looseObject({ type: z.literal("thinking_end"), contentIndex, content: z.string() }),
  z.looseObject({
    type: z.literal("toolcall_start"),
    contentIndex,
    id: nonEmpty,
    toolName: nonEmpty,
  }),
  z.looseObject({ type: z.literal("toolcall_delta"), contentIndex, delta: z.string() }),
  z.looseObject({ type: z.literal("toolcall_end"), contentIndex, toolCall: z.looseObject({}) }),
  z.looseObject({ type: z.literal("done"), reason: z.string() }),
  z.looseObject({ type: z.literal("error"), reason: z.string() }),
]);

const messageSchema = z.looseObject({ role: z.string().min(1).max(64) });

export const piTranslatedEventSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("agent_start") }),
  z.looseObject({ type: z.literal("agent_settled") }),
  z.looseObject({ type: z.literal("message_start"), message: messageSchema }),
  z.looseObject({ type: z.literal("message_end"), message: messageSchema }),
  z.looseObject({
    type: z.literal("message_update"),
    usage: piUsageSchema,
    assistantMessageEvent: assistantMessageEventSchema,
  }),
  z.looseObject({ type: z.literal("turn_end"), message: messageSchema }),
  z.looseObject({
    type: z.literal("tool_execution_start"),
    toolCallId: nonEmpty,
    toolName: nonEmpty,
    parentToolCallId: nonEmpty.optional(),
  }),
  z.looseObject({
    type: z.literal("tool_execution_update"),
    toolCallId: nonEmpty,
    toolName: nonEmpty,
  }),
  z.looseObject({
    type: z.literal("tool_execution_end"),
    toolCallId: nonEmpty,
    toolName: nonEmpty,
    isError: z.boolean(),
  }),
  z.looseObject({ type: z.literal("entry_appended"), entry: piSessionEntrySchema }),
]);
export type PiTranslatedEvent = z.infer<typeof piTranslatedEventSchema>;

export const PI_TRANSLATED_EVENT_TYPES = [
  "agent_start",
  "agent_settled",
  "message_start",
  "message_end",
  "message_update",
  "turn_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "entry_appended",
] as const;

export type TranslatedParse =
  | { readonly kind: "translated"; readonly event: PiTranslatedEvent }
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid"; readonly message: string };

export function parseTranslatedPiEvent(event: { readonly type: string }): TranslatedParse {
  if (!(PI_TRANSLATED_EVENT_TYPES as readonly string[]).includes(event.type)) {
    return { kind: "ignored" };
  }
  const parsed = piTranslatedEventSchema.safeParse(event);
  return parsed.success
    ? { kind: "translated", event: parsed.data }
    : { kind: "invalid", message: parsed.error.issues[0]?.message ?? "invalid Pi event" };
}

/**
 * Placeholder kobe-sandbox-agent sends **in place of** a Pi event it cannot put on the wire (the
 * frame would exceed the frame cap or fail the server's decoder: too deep, not serialisable). It
 * keeps the event's outbound `seq`, so seqs stay gapless and the server never loops on `resend`
 * for an event that can never arrive. Not a Pi type (the `kobe.` prefix cannot collide with one)
 * and not translated: the server accepts it, advances the cursor and produces no Kobe event.
 * `reason` is the encoder's code (`frame_too_large` | `malformed_frame`).
 */
export const KOBE_EVENT_DROPPED_TYPE = "kobe.event_dropped";
export const kobeEventDroppedSchema = z.strictObject({
  type: z.literal(KOBE_EVENT_DROPPED_TYPE),
  /** The dropped Pi event's `type`, truncated to 64 chars. */
  original_type: z.string().max(64),
  reason: z.enum(["frame_too_large", "malformed_frame"]),
});
export type KobeEventDropped = z.infer<typeof kobeEventDroppedSchema>;

/**
 * `data` of a successful `get_entries` response, validated before mirroring into `thread_entries`
 * (entry ids 1–128 chars, matching the KOBE-29 check; `leafId` must be one of the returned or
 * already-mirrored entries — the server checks the latter).
 */
export const piGetEntriesDataSchema = z.strictObject({
  entries: z.array(piSessionEntrySchema).max(10_000),
  leafId: z.string().min(1).max(128).nullable(),
});
export type PiGetEntriesData = z.infer<typeof piGetEntriesDataSchema>;
