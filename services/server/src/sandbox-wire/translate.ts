import {
  EventPayloadTooLargeError,
  jsonByteLength,
  parseEventPayload,
  parseTranslatedPiEvent,
  toolInputSchema,
  type KobeEventType,
  type PiTranslatedEvent,
  type RiskClass,
  type ToolRegistry,
} from "@kobe/protocol";
import type { NewRunEvent } from "../event-stream/append.js";
import { TOOL_INPUT_MAX_BYTES, TOOL_PREVIEW_MAX_CHARS } from "./constants.js";

/**
 * What one bridged Pi event means for Kobe (contract: `parseTranslatedPiEvent`, pi-events.ts).
 *
 * | Pi event                                     | Kobe effect                                         |
 * | -------------------------------------------- | --------------------------------------------------- |
 * | `message_start` (assistant)                  | opens stream-local `message_id` = `m<wire seq>`     |
 * | `message_update` `text_delta`/`thinking_delta` | `text.delta` / `reasoning.delta` (batched)        |
 * | `message_end` (assistant)                    | message id queued for `entry.committed` binding     |
 * | `tool_execution_start`                       | `tool.call` (input as executed, risk from registry) |
 * | `tool_execution_end`                         | `tool.result` (text preview, capped)                |
 * | `turn_end`, `entry_appended`                 | mirror new session entries (`get_entries since`)    |
 * | `agent_settled`                              | mirror entries, then the run completes              |
 * | anything else (incl. `kobe.event_dropped`)   | accepted, no effect                                 |
 *
 * Session entries are never taken from the event stream: Pi emits `entry_appended` only for
 * extension entries, so persisted entries (with their ids) come from `get_entries` (entries.ts).
 * Pi output is untrusted: every produced event passes its `@kobe/protocol` schema or is dropped.
 */
export interface Translation {
  readonly events: readonly NewRunEvent[];
  /** New session entries may exist: mirror them before the next write. */
  readonly syncEntries: boolean;
  /** Pi has no more automatic work for this run (`agent_settled`). */
  readonly settled: boolean;
  /** A known event type failed its schema: answered with `malformed_frame`, otherwise a no-op. */
  readonly invalid?: string;
  /** Produced events that failed their schema and were dropped (logged, never sent). */
  readonly dropped: number;
}

const NOTHING: Translation = { events: [], syncEntries: false, settled: false, dropped: 0 };

export interface RunTranslator {
  translate(seq: number, event: { readonly type: string }): Promise<Translation>;
  /** Assistant message ids in completion order, consumed when their entries are mirrored. */
  takeCompletedMessageId(): string | undefined;
}

type AssistantEvent = Extract<
  PiTranslatedEvent,
  { type: "message_update" }
>["assistantMessageEvent"];

function roleOf(event: PiTranslatedEvent): string | undefined {
  return "message" in event ? (event.message as { role?: string }).role : undefined;
}

/** A tool input for `tool.call`: the executed input when it is a safe, bounded JSON object. */
export function toolCallInput(args: unknown): Record<string, unknown> {
  const parsed = toolInputSchema.safeParse(args ?? {});
  if (!parsed.success) return { kobe_omitted: "invalid" };
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
  return bytes > TOOL_INPUT_MAX_BYTES ? { kobe_omitted: "too_large", bytes } : parsed.data;
}

/** Text preview of a Pi tool result (`{content: [{type:"text", text}, …]}`), capped. */
export function toolResultPreview(result: unknown): { preview: string; truncated: boolean } {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return { preview: "", truncated: false };
  let text = "";
  for (const part of content as unknown[]) {
    const p = part as { type?: unknown; text?: unknown } | null;
    if (p?.type === "text" && typeof p.text === "string") text += p.text;
    else if (typeof p?.type === "string") text += `[${p.type.slice(0, 32)}]`;
    if (text.length > TOOL_PREVIEW_MAX_CHARS) break;
  }
  if (text.length <= TOOL_PREVIEW_MAX_CHARS) return { preview: text, truncated: false };
  return { preview: text.slice(0, TOOL_PREVIEW_MAX_CHARS), truncated: true };
}

/** A translated event that was not produced: its type and why (never its content). */
export interface DroppedEvent {
  readonly type: KobeEventType;
  readonly reason: "payload_too_large" | "invalid_payload";
  /** UTF-8 JSON size, for `payload_too_large`. */
  readonly bytes?: number;
}

/**
 * Per-run translator. State (current message id, completed message ids) lives in the replica that
 * holds the run's connection; after a reconnect to another replica mid-message the next delta opens
 * a fresh `message_id` (still unique within the run: it is derived from the wire seq).
 */
export function createRunTranslator(options: {
  readonly teamId: string;
  readonly registry: ToolRegistry;
  /** Called for every event that fails its protocol schema or size bound (logged and counted). */
  readonly onDropped?: (dropped: DroppedEvent) => void;
}): RunTranslator {
  let current: string | undefined;
  let lastAssistant: string | undefined;
  const completed: string[] = [];

  const checked = (type: KobeEventType, payload: unknown): NewRunEvent | undefined => {
    try {
      return { type, payload: parseEventPayload(type, payload) };
    } catch (err) {
      options.onDropped?.(
        err instanceof EventPayloadTooLargeError
          ? { type, reason: "payload_too_large", bytes: jsonByteLength(payload) }
          : { type, reason: "invalid_payload" },
      );
      return undefined;
    }
  };

  const riskOf = async (tool: string): Promise<RiskClass> => {
    try {
      return (await options.registry.resolve(options.teamId, tool))?.risk ?? "destructive";
    } catch {
      return "destructive"; // D29: unknown = destructive
    }
  };

  const delta = (seq: number, e: AssistantEvent): NewRunEvent[] => {
    if (e.type !== "text_delta" && e.type !== "thinking_delta") return [];
    current ??= `m${seq}`;
    lastAssistant = current;
    const ev = checked(e.type === "text_delta" ? "text.delta" : "reasoning.delta", {
      message_id: current,
      content_index: e.contentIndex,
      delta: e.delta,
    });
    return ev ? [ev] : [];
  };

  const produce = async (seq: number, event: PiTranslatedEvent): Promise<Translation> => {
    switch (event.type) {
      case "message_start":
        if (roleOf(event) === "assistant") current = lastAssistant = `m${seq}`;
        return NOTHING;
      case "message_update": {
        const produced = delta(seq, event.assistantMessageEvent);
        const dropped =
          produced.length === 0 &&
          (event.assistantMessageEvent.type === "text_delta" ||
            event.assistantMessageEvent.type === "thinking_delta")
            ? 1
            : 0;
        return { ...NOTHING, events: produced, dropped };
      }
      case "message_end":
        if (roleOf(event) === "assistant" && current !== undefined) {
          completed.push(current);
          current = undefined;
        }
        return NOTHING;
      case "tool_execution_start": {
        const raw = event as { args?: unknown };
        const ev = checked("tool.call", {
          tool_call_id: event.toolCallId,
          ...(event.parentToolCallId === undefined
            ? {}
            : { parent_tool_call_id: event.parentToolCallId }),
          ...(lastAssistant === undefined ? {} : { message_id: lastAssistant }),
          tool: event.toolName,
          input: toolCallInput(raw.args),
          risk: await riskOf(event.toolName),
        });
        return { ...NOTHING, events: ev ? [ev] : [], dropped: ev ? 0 : 1 };
      }
      case "tool_execution_end": {
        const ev = checked("tool.result", {
          tool_call_id: event.toolCallId,
          tool: event.toolName,
          is_error: event.isError,
          ...toolResultPreview((event as { result?: unknown }).result),
        });
        return { ...NOTHING, events: ev ? [ev] : [], dropped: ev ? 0 : 1 };
      }
      case "turn_end":
      case "entry_appended":
        return { ...NOTHING, syncEntries: true };
      case "agent_settled":
        return { ...NOTHING, syncEntries: true, settled: true };
      default:
        return NOTHING;
    }
  };

  return {
    async translate(seq, event) {
      const parsed = parseTranslatedPiEvent(event);
      if (parsed.kind === "ignored") return NOTHING;
      if (parsed.kind === "invalid") return { ...NOTHING, invalid: parsed.message.slice(0, 200) };
      return produce(seq, parsed.event);
    },
    takeCompletedMessageId() {
      return completed.shift();
    },
  };
}
