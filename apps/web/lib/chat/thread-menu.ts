/**
 * What the rail's thread menu (KOBE-292) acts on: the branch on screen as Markdown (Copy) and the
 * last answer's branch point (Regenerate, Regenerate with), the same point the answer's own
 * Regenerate uses (`branchPoint`).
 */
import { isBusy, isThreadRunning, queuedRuns, type ThreadState } from "./thread-state";
import { branchPoint, type BranchPoint, type ProjectedItem, type Projection } from "./tree";

/** The messages on screen, oldest first: from the head up its parents. */
export function visibleBranch(projection: Projection): readonly ProjectedItem[] {
  const byId = new Map(projection.items.map((i) => [i.message.id, i] as const));
  const branch: ProjectedItem[] = [];
  const seen = new Set<string>();
  let id = projection.headId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const item = byId.get(id);
    if (!item) break;
    branch.push(item);
    id = item.parentId;
  }
  return branch.reverse();
}

const ROLE_HEADING: Readonly<Record<string, string>> = { user: "You", assistant: "Assistant" };

/** Stands in for an offloaded answer part whose body no route serves (only tool outputs). */
export const LONG_ANSWER_LEFT_OUT = "[long answer not included]";
/** Ends a copy whose entries could not all be read. */
export const MESSAGES_LEFT_OUT = "[messages that could not be loaded are not included]";

/** What a copy could not read (`conversationMarkdown` finds out). */
export interface CopyGaps {
  /** Offloaded entries that are tool outputs: left out like every tool output. */
  readonly toolOutputs?: ReadonlySet<string> | undefined;
  /** Not every page of entries was read. */
  readonly unread?: boolean | undefined;
}

export interface CopiedThread {
  readonly markdown: string;
  /** Something stands in for content that is not included. */
  readonly partial: boolean;
}

/** The offloaded entries of the branch on screen (their bodies are not in the entry list). */
export function offloadedOnBranch(projection: Projection): readonly string[] {
  return visibleBranch(projection).flatMap((item) => {
    const content = item.message.content;
    if (typeof content === "string") return [];
    return content.flatMap((part) =>
      part.type === "data-kobe-offloaded" ? [(part.data as { entryId: string }).entryId] : [],
    );
  });
}

/**
 * A message's text parts (reasoning, tool calls and notices are not part of the copy); an
 * offloaded part that is not a tool output becomes a placeholder.
 */
function textOf(
  message: ProjectedItem["message"],
  toolOutputs: ReadonlySet<string>,
): { readonly text: string; readonly partial: boolean } {
  const content = message.content;
  if (typeof content === "string") return { text: content.trim(), partial: false };
  let partial = false;
  const texts = content.flatMap((part) => {
    if (part.type === "text") return [part.text.trim()];
    if (part.type !== "data-kobe-offloaded") return [];
    if (toolOutputs.has((part.data as { entryId: string }).entryId)) return [];
    partial = true;
    return [LONG_ANSWER_LEFT_OUT];
  });
  return { text: texts.filter((t) => t !== "").join("\n\n"), partial };
}

/**
 * The conversation on screen as Markdown: the title, then each message under its author, with a
 * placeholder line wherever something could not be included (`partial`).
 */
export function threadMarkdown(
  title: string,
  projection: Projection,
  gaps: CopyGaps = {},
): CopiedThread {
  const toolOutputs = gaps.toolOutputs ?? new Set<string>();
  const blocks = [`# ${title}`];
  let partial = gaps.unread === true;
  for (const item of visibleBranch(projection)) {
    const body = textOf(item.message, toolOutputs);
    partial ||= body.partial;
    if (body.text === "") continue;
    blocks.push(`## ${ROLE_HEADING[item.message.role] ?? item.message.role}`, body.text);
  }
  if (gaps.unread) blocks.push(MESSAGES_LEFT_OUT);
  return { markdown: `${blocks.join("\n\n")}\n`, partial };
}

/** The last answer's prompt and the entry to branch it from, or undefined when there is none. */
export function lastAnswerPoint(projection: Projection): BranchPoint | undefined {
  const answer = visibleBranch(projection).findLast((i) => i.message.role === "assistant");
  return answer ? branchPoint(projection, answer.parentId) : undefined;
}

/**
 * Why Regenerate and Regenerate with are unavailable from the menu, or null: the conversation is
 * read, the caller's own and out of Trash, nothing runs, queues or is being sent, and no model
 * change is in flight (`canRegenerateWith`, with a reason for the tooltip).
 */
export function regenerateBlocker(state: ThreadState): string | null {
  if (state.phase === "loading") return "Opening the conversation…";
  const summary = state.summary;
  if (state.phase === "error" || !summary) return "The conversation could not be read.";
  if (summary.readOnly === true) return "This conversation is shared with you read-only.";
  if (summary.deletedAt != null) return "Restore the conversation first.";
  // The summary's status first: the controller is ready before it has read the runs.
  const running = summary.status === "running" || isThreadRunning(state);
  if (running || state.sending !== undefined || queuedRuns(state).length > 0) {
    return "Wait for the current run to finish.";
  }
  if (isBusy(state, "model")) return "Changing the model…";
  return null;
}
