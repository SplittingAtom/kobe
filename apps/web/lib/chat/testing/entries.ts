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

/** The server-written skipped-actions summary of a scheduled run (KOBE-178): never a Pi entry. */
export const skippedSummary = (id: string, parent: string, content: string, count = 1) => {
  seq += 1;
  return {
    entryId: id,
    parentId: parent,
    seq,
    type: "custom_message",
    payload: {
      type: "custom_message",
      id,
      parentId: parent,
      customType: "kobe.skipped_actions",
      content,
      display: true,
      details: { run_id: "r1", skipped_count: count },
    },
    payloadOffloaded: false,
    createdAt: "2026-10-02T10:00:00.000Z",
  } satisfies ThreadEntry;
};

/** Pi's `model_change` entry (the model a session switched to). */
export const modelChange = (id: string, parent: string | null, modelId: string) => ({
  ...entry(id, parent, null, "model_change"),
  payload: { type: "model_change", id, parentId: parent, provider: "kobe", modelId },
});

/** Pi's `compaction` entry: the summary that replaces everything before `firstKeptEntryId`. */
export const compaction = (
  id: string,
  parent: string,
  summary: string,
  firstKeptEntryId: string,
  tokensBefore = 120_000,
) => ({
  ...entry(id, parent, null, "compaction"),
  payload: { type: "compaction", id, parentId: parent, summary, firstKeptEntryId, tokensBefore },
});

/** An assistant step with the model it came from and Pi's usage (KOBE-545 tree fixtures). */
export const answered = (
  id: string,
  parent: string,
  model: string,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  ...content: Record<string, unknown>[]
) => entry(id, parent, { role: "assistant", content, model, usage });

/** The sandbox agent's `kobe.branch` marker: where an edit or a regenerate branches (KOBE-214). */
export const branchMarker = (id: string, parent: string) => ({
  ...entry(id, parent, null, "custom"),
  payload: { type: "custom", id, parentId: parent, customType: "kobe.branch", data: {} },
});

/** Pi's `branch_summary` entry: the summary of the branch left, carried into this one (CT11). */
export const branchSummary = (id: string, parent: string, summary: string) => ({
  ...entry(id, parent, null, "branch_summary"),
  payload: { type: "branch_summary", id, parentId: parent, summary },
});

/** A tool result of a named tool (the default `toolResult` says bash). */
export const namedResult = (
  id: string,
  parent: string,
  toolCallId: string,
  toolName: string,
  isError = false,
) =>
  entry(id, parent, {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: isError ? "failed" : "ok" }],
    isError,
  });

/** A rail-launched app card (KOBE-440): a server entry, `ka-` and 24 hex characters. */
export const appCardEntry = (id: string, parent: string) => ({
  ...entry(id, parent, null, "custom_message"),
  payload: {
    type: "custom_message",
    id,
    parentId: parent,
    customType: "kobe.app_card",
    content: "",
    display: true,
    details: { tool: "lake_query" },
  },
});
