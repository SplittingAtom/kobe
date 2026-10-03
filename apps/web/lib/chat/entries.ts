/**
 * Reading Pi 1.0 session entries (D15: `thread_entries.payload` is the Pi entry as stored). The
 * payload is agent output, so nothing is assumed: every field is checked and anything unexpected
 * degrades to "nothing to show" rather than throwing. Shapes (verified against the Pi 1.0.0 session
 * format used by KOBE-23/24): `{type: "message", id, parentId, timestamp, message: {role, content}}`
 * where `role` is `user` (content: string | parts), `assistant` (parts: text / thinking / toolCall,
 * plus `stopReason` and `errorMessage`) or `toolResult` (`toolCallId`, `toolName`, `content`,
 * `isError`). Other entry types (`model_change`, `compaction`, `branch_summary`, …) are not
 * conversation turns.
 */
import type { ThreadEntry } from "./types";

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
      /** Set when the model step ended in an error or was aborted. */
      readonly problem?: { readonly reason: "error" | "aborted"; readonly message: string };
    }
  | {
      readonly kind: "toolResult";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly text: string;
      readonly isError: boolean;
    }
  /** A message whose body is in object storage (D15); its role is unknown here. */
  | { readonly kind: "offloaded" }
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

function assistantProblem(message: Record<string, unknown>) {
  const reason = message.stopReason;
  if (reason !== "error" && reason !== "aborted") return undefined;
  const fallback = reason === "error" ? "The model returned an error." : "This step was stopped.";
  return { reason, message: clip(str(message.errorMessage) ?? fallback).slice(0, 2000) } as const;
}

export function parseEntry(entry: ThreadEntry): ParsedEntry {
  if (entry.payloadOffloaded) return { kind: "offloaded" };
  if (entry.type !== "message") return { kind: "other", type: entry.type };
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
