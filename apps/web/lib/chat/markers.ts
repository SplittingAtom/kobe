/**
 * Inline system markers (KOBE-209, CE12/CE16): thin rows between messages for what is not a
 * conversation turn. Two sources:
 * - entries of the Pi tree (`model_change`, `compaction`), placed by the tree projection where
 *   they sit (`tree.ts`), so they never become messages or branches of their own;
 * - what only the server knows (`GET /v1/threads/{id}/markers`): runs that ended interrupted,
 *   budget-stopped, stopped or failed, and decided approvals, placed on the messages the
 *   projection already has.
 * Forks need no data: assistant-ui knows each message's branches (`markers.tsx`).
 */
import type { ApprovalResolutionCause } from "@kobe/protocol";
import type { ParsedEntry } from "./entries";
import type { Projection } from "./tree";
import type { ThreadEntry } from "./types";

export type EntryMarker =
  | {
      readonly kind: "model";
      readonly entryId: string;
      readonly model: string;
      /** The branch records no model above it: "Model: X", not a change (KOBE-280). */
      readonly first: boolean;
      /**
       * The model in effect where the marker's row of markers starts (after the message above it,
       * or at the fork it is carried from); null: none yet. A chain of model markers is shown as
       * its net change from this model (`netModelMarkers`).
       */
      readonly from: string | null;
    }
  | {
      readonly kind: "compaction";
      readonly entryId: string;
      /** Pi's summary; empty when its body is in object storage. */
      readonly summary: string;
      /** Conversation entries this compaction folded into the summary; unknown if not loaded. */
      readonly folded?: number | undefined;
      readonly tokensBefore?: number | undefined;
    };

/** A run that ended without finishing its answer (`runs.status`); stopped or failed: KOBE-290. */
export interface RunMarker {
  readonly runId: string;
  readonly status: "interrupted" | "budget_stopped" | "cancelled" | "failed";
  /** A failed run's message (the server's text for its failure code). */
  readonly message?: string | undefined;
  readonly userEntryId: string | null;
  readonly parentEntryId: string | null;
}

/** A decided approval: its outcome only. */
export interface ApprovalMarker {
  readonly approvalId: string;
  readonly runId: string;
  /** The run's prompt: tool call ids are only unique within a run. */
  readonly userEntryId: string | null;
  readonly toolCallId: string;
  readonly status: "allowed" | "denied" | "expired";
  readonly cause: ApprovalResolutionCause | null;
}

/** A skill the server saw a run use (KOBE-297): its SKILL.md was read by this tool call. */
export interface SkillMarker {
  readonly runId: string;
  /** The run's prompt: tool call ids are only unique within a run. */
  readonly userEntryId: string | null;
  readonly toolCallId: string;
  readonly name: string;
  readonly source: "team" | "personal" | "builtin" | "catalog";
  /** The version the run loaded (KOBE-315); absent for built-ins and older runs. */
  readonly semver?: string | undefined;
}

/**
 * "Skill updated: xlsx 1.4.2 → 1.4.3" (KOBE-315, CE12): the run loaded a skill at another version
 * than the thread's last run with it. Shown above that run's prompt.
 */
export interface SkillUpdateMarker {
  readonly runId: string;
  readonly userEntryId: string | null;
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

/**
 * The thread moved to another project (CE19, KOBE-220), shown above the prompt of the first run
 * that started after the move: from there the agent works with the new project's instructions.
 * Id and name are null for no project; `*Hidden` marks a project the viewer can't open (its id
 * is not sent): "another project". Absent `*Hidden` (an older answer) reads as false.
 */
export interface ProjectMarker {
  readonly runId: string;
  readonly userEntryId: string | null;
  readonly parentEntryId: string | null;
  readonly fromProjectId: string | null;
  readonly fromProjectName: string | null;
  readonly fromProjectHidden?: boolean | undefined;
  readonly toProjectId: string | null;
  readonly toProjectName: string | null;
  readonly toProjectHidden?: boolean | undefined;
}

export interface ThreadMarkers {
  readonly runs: readonly RunMarker[];
  /** Absent from servers before KOBE-220. */
  readonly projects?: readonly ProjectMarker[] | undefined;
  readonly approvals: readonly ApprovalMarker[];
  /** Absent from servers before KOBE-297. */
  readonly skills?: readonly SkillMarker[] | undefined;
  /** Absent from servers before KOBE-315. */
  readonly skillUpdates?: readonly SkillUpdateMarker[] | undefined;
  /** Older markers were left out (the server returns the newest 500 of each). */
  readonly truncated?: boolean | undefined;
}

/** The key a skill marker of the live run is found by before its prompt is in the tree. */
export function runToolKey(runId: string, toolCallId: string): string {
  return `${runId}\u0000${toolCallId}`;
}

/** The key an approval's (or a skill's) marker is found by: its run's prompt and the tool call. */
export function approvalKey(promptEntryId: string | undefined | null, toolCallId: string): string {
  return `${promptEntryId ?? ""}\u0000${toolCallId}`;
}

/**
 * How many conversation entries a compaction newly folded: those above its first kept entry, down
 * to the first kept entry of an earlier compaction on the same path (Pi had already folded the
 * rest), or to that compaction itself when its body is offloaded. Undefined when the first kept
 * entry is not an ancestor that is loaded.
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
    if (p?.kind === "compaction") {
      // An earlier compaction whose body is offloaded: where it cut is unknown, so stop here.
      if (p.firstKeptEntryId === null) break;
      stop = p.firstKeptEntryId;
    } else if (byId.get(id)?.type === "message") count += 1;
    if (id === stop) break;
    id = parentOf.get(id) ?? null;
  }
  return count;
}

/** The models a branch records above an entry (KOBE-280); null: none yet. */
export interface BranchModels {
  /** The latest one (`recordedModel`). */
  readonly model: string | null;
  /** The one in effect where the entry's row of markers starts. */
  readonly from: string | null;
}

/**
 * The marker an entry shows, if it shows one. A model marker that changes nothing (a KOBE-259
 * limits re-select, a Pi started without a model and then reused) is dropped when its row is shown
 * (`netModelMarkers`).
 */
export function entryMarker(
  entry: ThreadEntry,
  parsed: ReadonlyMap<string, ParsedEntry>,
  parentOf: ReadonlyMap<string, string | null>,
  byId: ReadonlyMap<string, ThreadEntry>,
  branch: BranchModels,
): EntryMarker | undefined {
  const p = parsed.get(entry.entryId);
  if (p?.kind === "modelChange") {
    return {
      kind: "model",
      entryId: entry.entryId,
      model: p.model,
      first: branch.model === null,
      from: branch.from,
    };
  }
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

/**
 * Where each project move shows, by message id: above the prompt of the run it marks. A run whose
 * prompt is not in the loaded tree (never mirrored, another page) is left out.
 */
export function placeProjectMarkers<T extends { readonly userEntryId: string | null }>(
  moves: readonly T[],
  projection: Projection,
): ReadonlyMap<string, readonly T[]> {
  const placed = new Map<string, T[]>();
  for (const move of moves) {
    const at = move.userEntryId === null ? undefined : projection.nodeOfEntry.get(move.userEntryId);
    if (at === undefined) continue;
    placed.set(at, [...(placed.get(at) ?? []), move]);
  }
  return placed;
}
