import type { ProjectCommitOutcome, ToolsResponse } from "./protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isSeq = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** The outcome of a `commit_project` answer (project-commits.ts), or undefined (fail closed). */
function parseCommitOutcome(value: unknown): ProjectCommitOutcome | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort().join(",");
  switch (value.status) {
    case "committed":
      return keys === "seq,status" && isSeq(value.seq)
        ? { status: "committed", seq: value.seq }
        : undefined;
    case "commit_conflict":
      return keys === "head_seq,status" && isSeq(value.head_seq)
        ? { status: "commit_conflict", head_seq: value.head_seq }
        : undefined;
    case "nothing_to_commit":
    case "pending_approval":
      return keys === "status" ? { status: value.status } : undefined;
    default:
      return undefined;
  }
}

/** A `commit_project` answer (KOBE-580), or undefined when it is malformed (fail closed). */
export function parseProjectCommitReply(value: Record<string, unknown>): ToolsResponse | undefined {
  const outcome = parseCommitOutcome(value.outcome);
  if (outcome === undefined) return undefined;
  return { id: value.id as string, ok: true, op: "project_commit", outcome };
}
