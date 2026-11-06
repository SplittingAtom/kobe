/**
 * Badges of a tree node (CT6, KOBE-545): what an answer's run left behind that branching does not
 * undo. Counted client-side, best effort, from the tool calls in the node's own entries: Pi's
 * `write` and `edit` tools (a shell command that writes is not seen) and the memory agent's
 * `remember` (services/sandbox-agent kobe-tools). Only a call with a stored, non-error result
 * counts: a failed call, or one cut off with no result (the run stopped mid-call), is left out.
 */
import type { ParsedEntry } from "./entries";
import type { ThreadEntry } from "./types";

/** Pi's file-changing tools (services/sandbox-agent `kobe-exec/tools.ts` TOOL_NAMES). */
export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/** The memory agent's write tool (`kobe-tools/protocol.ts` TOOL_REMEMBER); `recall` only reads. */
export const MEMORY_WRITE_TOOLS: ReadonlySet<string> = new Set(["remember"]);

/** Paths listed in a files badge's tooltip at most. */
export const BADGE_PATHS_MAX = 20;

export interface TreeBadges {
  /** Distinct files written or edited. */
  readonly files?: number;
  /** Those files' paths, first written first (the tooltip), at most {@link BADGE_PATHS_MAX}. */
  readonly paths?: readonly string[];
  readonly memories?: number;
  /** The node's run wrote a remember-rule (CT2's `runs[].remembered_rule`). */
  readonly rule?: true;
}

const MAX_PATH = 512;

function pathOf(args: Readonly<Record<string, unknown>>): string | undefined {
  const value = args.path ?? args.file_path;
  return typeof value === "string" && value !== "" ? value.slice(0, MAX_PATH) : undefined;
}

/**
 * The files and memories badges of one node. `succeeded` holds the tool call ids with a stored,
 * non-error result (from every loaded entry: a result can sit past the node's last listed entry).
 */
export function toolBadges(
  entries: readonly ThreadEntry[],
  parsed: ReadonlyMap<string, ParsedEntry>,
  succeeded: ReadonlySet<string>,
): TreeBadges {
  const paths = new Set<string>();
  let writesWithoutPath = 0;
  let memories = 0;
  for (const entry of entries) {
    const p = parsed.get(entry.entryId);
    if (p?.kind !== "assistant") continue;
    for (const piece of p.pieces) {
      if (piece.kind !== "toolCall" || !succeeded.has(piece.toolCallId)) continue;
      if (FILE_WRITE_TOOLS.has(piece.toolName)) {
        const path = pathOf(piece.args);
        if (path === undefined) writesWithoutPath += 1;
        else paths.add(path);
      } else if (MEMORY_WRITE_TOOLS.has(piece.toolName)) memories += 1;
    }
  }
  const files = paths.size + writesWithoutPath;
  return {
    ...(files > 0 ? { files, paths: [...paths].slice(0, BADGE_PATHS_MAX) } : {}),
    ...(memories > 0 ? { memories } : {}),
  };
}

/** Tool call ids whose stored result is not an error (what {@link toolBadges} counts). */
export function succeededToolCalls(
  entries: readonly ThreadEntry[],
  parsed: ReadonlyMap<string, ParsedEntry>,
): ReadonlySet<string> {
  const ok = new Set<string>();
  for (const entry of entries) {
    const p = parsed.get(entry.entryId);
    if (p?.kind === "toolResult" && !p.isError) ok.add(p.toolCallId);
  }
  return ok;
}

/** Tool call ids whose stored result is an error. */
export function failedToolCalls(
  entries: readonly ThreadEntry[],
  parsed: ReadonlyMap<string, ParsedEntry>,
): ReadonlySet<string> {
  const failed = new Set<string>();
  for (const entry of entries) {
    const p = parsed.get(entry.entryId);
    if (p?.kind === "toolResult" && p.isError) failed.add(p.toolCallId);
  }
  return failed;
}
