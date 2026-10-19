/**
 * Reading Pi 1.0 session entries (D15: `thread_entries.payload` is the Pi entry as stored). The
 * payload is agent output, so nothing is assumed: every field is checked and anything unexpected
 * degrades to "nothing to show" rather than throwing. Shapes (verified against the Pi 1.0.0 session
 * format used by KOBE-23/24): `{type: "message", id, parentId, timestamp, message: {role, content}}`
 * where `role` is `user` (content: string | parts), `assistant` (parts: text / thinking / toolCall,
 * plus `stopReason` and `errorMessage`) or `toolResult` (`toolCallId`, `toolName`, `content`,
 * `isError`). Other entry types (`model_change`, `compaction`, `branch_summary`, …) are not
 * conversation turns; `model_change` and `compaction` are shown as markers (KOBE-209). One entry is the server's, not Pi's: a scheduled run's skipped-actions
 * summary (KOBE-178), a `custom_message` with `customType` {@link SKIPPED_SUMMARY_TYPE}.
 */
import type { ThreadEntry } from "./types";

/** `customType` of the server-written skipped-actions summary of a scheduled run (KOBE-178). */
export const SKIPPED_SUMMARY_TYPE = "kobe.skipped_actions";

/** `customType` of an app card a member launched from the rail (KOBE-440). */
export const APP_CARD_TYPE = "kobe.app_card";

export type AssistantPiece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "toolCall";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: Readonly<Record<string, unknown>>;
    };

export type ParsedEntry =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly pieces: readonly AssistantPiece[];
      /** Set when the model step ended in an error, was aborted or hit the output limit. */
      readonly problem?: {
        readonly reason: "error" | "aborted" | "length";
        readonly message: string;
      };
    }
  | {
      readonly kind: "toolResult";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly text: string;
      readonly isError: boolean;
    }
  /**
   * A scheduled run's skipped-actions summary. Pi does not know it: it is never a branch point,
   * a leaf, or a message of its own (the server refuses it as a parent, 422 invalid_parent_entry).
   */
  | { readonly kind: "skipped"; readonly text: string; readonly count: number }
  /**
   * An app card (KOBE-440, spec MA11): a member launched an app from the rail. Its own message in
   * the conversation (no model turn); the app and its stored result come from the thread's app
   * results by entry id.
   */
  | { readonly kind: "appCard"; readonly tool: string }
  /** A message whose body is in object storage (D15); its role is unknown here. */
  | { readonly kind: "offloaded" }
  /** Pi switched the session's model (KOBE-209 marker). */
  | { readonly kind: "modelChange"; readonly model: string }
  /**
   * Pi folded the context before `firstKeptEntryId` into `summary` (KOBE-209 marker); the summary
   * is empty when the entry's body is in object storage.
   */
  | {
      readonly kind: "compaction";
      readonly summary: string;
      readonly firstKeptEntryId: string | null;
      readonly tokensBefore?: number | undefined;
    }
  /** Not a conversation turn: kept in the tree, never rendered. */
  | { readonly kind: "other"; readonly type: string };

const MAX_TEXT = 200_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** Text of a content field: a string, or the `text` parts of a part list (images noted). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return clip(content);
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const part of content) {
    const p = record(part);
    if (p?.type === "text" && typeof p.text === "string") out.push(p.text);
    else if (p?.type === "image") out.push("[image]");
  }
  return clip(out.join(""));
}

function assistantPieces(content: unknown): AssistantPiece[] {
  if (typeof content === "string") return content === "" ? [] : [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const pieces: AssistantPiece[] = [];
  for (const part of content) {
    const p = record(part);
    if (!p) continue;
    if (p.type === "text" && typeof p.text === "string") {
      pieces.push({ kind: "text", text: clip(p.text) });
    } else if (p.type === "thinking" && typeof p.thinking === "string") {
      pieces.push({ kind: "reasoning", text: clip(p.thinking) });
    } else if (p.type === "toolCall" && typeof p.id === "string" && typeof p.name === "string") {
      pieces.push({
        kind: "toolCall",
        toolCallId: p.id,
        toolName: p.name,
        args: record(p.arguments) ?? {},
      });
    }
  }
  return pieces;
}

/** KOBE-258: Pi's `stopReason: "length"`; the run's own failure says what to do about it. */
const OUTPUT_LIMIT = "The model hit its output limit here, so this reply is incomplete.";

function assistantProblem(message: Record<string, unknown>) {
  const reason = message.stopReason;
  if (reason === "length") return { reason, message: OUTPUT_LIMIT } as const;
  if (reason !== "error" && reason !== "aborted") return undefined;
  const fallback = reason === "error" ? "The model returned an error." : "This step was stopped.";
  return { reason, message: clip(str(message.errorMessage) ?? fallback).slice(0, 2000) } as const;
}

const MAX_SUMMARY = 20_000;

/** The id prefix the server gives a summary entry (`ks-<run>`); Pi's entry ids are short hex. */
const SKIPPED_SUMMARY_ID = "ks-";

/**
 * A summary is known by its `customType`, or by its server id when its body is offloaded (the
 * payload is then empty): either way it must never enter the tree as a branch or a head.
 */
function isSkippedSummary(entry: ThreadEntry): boolean {
  return (
    entry.type === "custom_message" &&
    (entry.payload.customType === SKIPPED_SUMMARY_TYPE ||
      (entry.payloadOffloaded && entry.entryId.startsWith(SKIPPED_SUMMARY_ID)))
  );
}

function skippedSummary(entry: ThreadEntry): ParsedEntry | undefined {
  if (!isSkippedSummary(entry)) return undefined;
  const count = record(entry.payload.details)?.skipped_count;
  return {
    kind: "skipped",
    text: entry.payloadOffloaded ? "" : contentText(entry.payload.content).slice(0, MAX_SUMMARY),
    count: typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 0,
  };
}

const MAX_MODEL_NAME = 200;

/** Pi's `model_change` (`provider`, `modelId`) and `compaction` (`summary`, `firstKeptEntryId`). */
function systemEntry(entry: ThreadEntry): ParsedEntry | undefined {
  const payload = entry.payload;
  if (entry.type === "compaction") {
    const tokens = payload.tokensBefore;
    return {
      kind: "compaction",
      summary: (str(payload.summary) ?? "").slice(0, MAX_SUMMARY),
      firstKeptEntryId: str(payload.firstKeptEntryId) ?? null,
      ...(typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0
        ? { tokensBefore: tokens }
        : {}),
    };
  }
  if (entry.type !== "model_change" || entry.payloadOffloaded) return undefined;
  const model = str(payload.modelId) ?? "";
  return model === "" ? undefined : { kind: "modelChange", model: model.slice(0, MAX_MODEL_NAME) };
}

/**
 * The model an entry records for its branch, as Pi resolves a branch's model (its latest
 * `model_change` or answer): a `model_change`'s model, or the model an answer came from.
 */
export function recordedModel(entry: ThreadEntry, parsed: ParsedEntry): string | undefined {
  if (parsed.kind === "modelChange") return parsed.model;
  if (parsed.kind !== "assistant") return undefined;
  const model = str(record(entry.payload.message)?.model);
  return model === undefined || model === "" ? undefined : model.slice(0, MAX_MODEL_NAME);
}

/** The server's app card ids: `ka-` and 24 hex characters. */
const APP_CARD_ID = /^ka-[0-9a-f]{24}$/;

function appCard(entry: ThreadEntry): ParsedEntry | undefined {
  if (entry.type !== "custom_message" || !APP_CARD_ID.test(entry.entryId)) return undefined;
  if (!entry.payloadOffloaded && entry.payload.customType !== APP_CARD_TYPE) return undefined;
  const tool = str(record(entry.payload.details)?.tool) ?? "";
  return { kind: "appCard", tool: tool.slice(0, 128) };
}

export function parseEntry(entry: ThreadEntry): ParsedEntry {
  const skipped = skippedSummary(entry);
  if (skipped) return skipped;
  const card = appCard(entry);
  if (card) return card;
  const system = systemEntry(entry);
  if (system) return system;
  // Only a message's body is an answer part; any other kind stays a hidden entry.
  if (entry.type !== "message") return { kind: "other", type: entry.type };
  if (entry.payloadOffloaded) return { kind: "offloaded" };
  const message = record(entry.payload.message);
  if (!message) return { kind: "other", type: entry.type };
  switch (message.role) {
    case "user":
      return { kind: "user", text: contentText(message.content) };
    case "assistant": {
      const problem = assistantProblem(message);
      return {
        kind: "assistant",
        pieces: assistantPieces(message.content),
        ...(problem ? { problem } : {}),
      };
    }
    case "toolResult": {
      const toolCallId = str(message.toolCallId);
      if (toolCallId === undefined) return { kind: "other", type: "toolResult" };
      return {
        kind: "toolResult",
        toolCallId,
        toolName: str(message.toolName) ?? "",
        text: contentText(message.content),
        isError: message.isError === true,
      };
    }
    default:
      return { kind: "other", type: `message:${String(message.role).slice(0, 32)}` };
  }
}
