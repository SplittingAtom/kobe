/**
 * Inline system markers (KOBE-209, CE12/CE16): thin rows between messages for what is not a
 * conversation turn. Two sources:
 * - entries of the Pi tree (`model_change`, `compaction`), placed by the tree projection where
 *   they sit (`tree.ts`), so they never become messages or branches of their own;
 * - what only the server knows (`GET /v1/threads/{id}/markers`): runs that ended interrupted or
 *   budget-stopped, and decided approvals, placed on the messages the projection already has.
 * Forks need no data: assistant-ui knows each message's branches (`markers.tsx`).
 */
import type { ApprovalResolutionCause } from "@kobe/protocol";
import type { ParsedEntry } from "./entries";
import type { Projection } from "./tree";
import type { ThreadEntry } from "./types";

export type EntryMarker =
  | { readonly kind: "model"; readonly entryId: string; readonly model: string }
  | {
      readonly kind: "compaction";
      readonly entryId: string;
      /** Pi's summary; empty when its body is in object storage. */
      readonly summary: string;
      /** Conversation entries this compaction folded into the summary; unknown if not loaded. */
      readonly folded?: number | undefined;
      readonly tokensBefore?: number | undefined;
    };

/** A run that ended without finishing its answer (`runs.status`). */
export interface RunMarker {
  readonly runId: string;
  readonly status: "interrupted" | "budget_stopped";
  readonly userEntryId: string | null;
  readonly parentEntryId: string | null;
  readonly endedAt: string | null;
}

/** A decided approval: its outcome only. */
export interface ApprovalMarker {
  readonly approvalId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly status: "allowed" | "denied" | "expired";
  readonly cause: ApprovalResolutionCause | null;
  readonly decidedAt: string | null;
}

export interface ThreadMarkers {
  readonly runs: readonly RunMarker[];
  readonly approvals: readonly ApprovalMarker[];
}

/**
 * How many conversation entries a compaction newly folded: those above its first kept entry, down
 * to the first kept entry of an earlier compaction on the same path (Pi had already folded the
 * rest). Undefined when the first kept entry is not an ancestor that is loaded.
 */
function foldedCount(
  entry: ThreadEntry,
  firstKept: string,
  parentOf: ReadonlyMap<string, string | null>,
  byId: ReadonlyMap<string, ThreadEntry>,
  parsed: ReadonlyMap<string, ParsedEntry>,
): number | undefined {
  const seen = new Set<string>();
  let id = entry.parentId;
  while (id !== null && id !== firstKept && !seen.has(id)) {
    seen.add(id);
    id = parentOf.get(id) ?? null;
  }
  if (id !== firstKept) return undefined;
  let count = 0;
  let stop: string | null = null;
  id = parentOf.get(firstKept) ?? null;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const p = parsed.get(id);
    if (p?.kind === "compaction") stop = p.firstKeptEntryId;
    else if (byId.get(id)?.type === "message") count += 1;
    if (id === stop) break;
    id = parentOf.get(id) ?? null;
  }
  return count;
}

/** The marker an entry shows, if it shows one. */
export function entryMarker(
  entry: ThreadEntry,
  parsed: ReadonlyMap<string, ParsedEntry>,
  parentOf: ReadonlyMap<string, string | null>,
  byId: ReadonlyMap<string, ThreadEntry>,
): EntryMarker | undefined {
  const p = parsed.get(entry.entryId);
  if (p?.kind === "modelChange") return { kind: "model", entryId: entry.entryId, model: p.model };
  if (p?.kind !== "compaction") return undefined;
  const folded =
    p.firstKeptEntryId === null
      ? undefined
      : foldedCount(entry, p.firstKeptEntryId, parentOf, byId, parsed);
  return {
    kind: "compaction",
    entryId: entry.entryId,
    summary: p.summary,
    ...(folded === undefined ? {} : { folded }),
    ...(p.tokensBefore === undefined ? {} : { tokensBefore: p.tokensBefore }),
  };
}

/**
 * Where each run's marker shows, by message id: after the last answer to its prompt, under the
 * prompt when nothing answered it, or after the message it continued from when its prompt never
 * reached the tree. A run whose entries are not loaded is left out.
 */
export function placeRunMarkers(
  runs: readonly RunMarker[],
  projection: Projection,
): ReadonlyMap<string, readonly RunMarker[]> {
  const answerOf = new Map<string, string>();
  for (const item of projection.items) {
    const custom = item.message.metadata?.custom as
      { readonly kind?: string; readonly promptEntryId?: string } | undefined;
    if (custom?.kind === "assistant" && custom.promptEntryId !== undefined) {
      answerOf.set(custom.promptEntryId, item.message.id);
    }
  }
  const placed = new Map<string, RunMarker[]>();
  for (const run of runs) {
    const at =
      run.userEntryId !== null
        ? (answerOf.get(run.userEntryId) ?? projection.nodeOfEntry.get(run.userEntryId))
        : run.parentEntryId !== null
          ? projection.nodeOfEntry.get(run.parentEntryId)
          : undefined;
    if (at === undefined) continue;
    placed.set(at, [...(placed.get(at) ?? []), run]);
  }
  return placed;
}
