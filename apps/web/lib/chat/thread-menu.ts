/**
 * What the rail's thread menu (KOBE-292) acts on: the branch on screen as Markdown (Copy) and the
 * last answer's branch point (Regenerate, Regenerate with), the same point the answer's own
 * Regenerate uses (`branchPoint`).
 */
import { isBusy, isThreadRunning, queuedRuns, type ThreadState } from "./thread-state";
import { branchPoint, type ProjectedItem, type Projection } from "./tree";

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

/** A message's text parts (reasoning, tool calls and notices are not part of the copy). */
function textOf(message: ProjectedItem["message"]): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  return content
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
    .filter((t) => t !== "")
    .join("\n\n");
}

/** The conversation on screen as Markdown: the title, then each message under its author. */
export function threadMarkdown(title: string, projection: Projection): string {
  const blocks = [`# ${title}`];
  for (const item of visibleBranch(projection)) {
    const body = textOf(item.message);
    if (body === "") continue;
    blocks.push(`## ${ROLE_HEADING[item.message.role] ?? item.message.role}`, body);
  }
  return `${blocks.join("\n\n")}\n`;
}

/** The last answer's prompt and the entry to branch it from, or undefined when there is none. */
export function lastAnswerPoint(
  projection: Projection,
): { readonly parentEntryId: string; readonly text: string } | undefined {
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
