/** Builders for Pi session entries as the Thread API returns them (camelized, payload verbatim). */
import type { ThreadEntry } from "../types";

let seq = 0;

export function resetEntrySeq(): void {
  seq = 0;
}

export function entry(
  entryId: string,
  parentId: string | null,
  message: Record<string, unknown> | null,
  type = "message",
): ThreadEntry {
  seq += 1;
  return {
    entryId,
    parentId,
    seq,
    type,
    payload:
      message === null ? { type, id: entryId, parentId } : { type, id: entryId, parentId, message },
    payloadOffloaded: false,
    createdAt: "2026-10-02T10:00:00.000Z",
  };
}

export const user = (id: string, parent: string | null, text: string) =>
  entry(id, parent, { role: "user", content: text });

export const assistant = (
  id: string,
  parent: string | null,
  ...content: Record<string, unknown>[]
) => entry(id, parent, { role: "assistant", content });

export const text = (t: string) => ({ type: "text", text: t });
export const toolCall = (id: string, name: string, args: Record<string, unknown> = {}) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

export const toolResult = (
  id: string,
  parent: string,
  toolCallId: string,
  output: string,
  isError = false,
) =>
  entry(id, parent, {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text: output }],
    isError,
  });
