import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { LineSplitter } from "../jsonl.js";
import { PI_MAX_LINE_BYTES } from "../pi/pi-process.js";

/**
 * The context of a thread's latest model call rebuilt from its Pi session file (KOBE-470, CV4),
 * for when no call was captured since this sandbox's Pi started. Follows Pi 1.0.0's
 * `buildSessionContext` (docs/session-format.md "Context Building"): the path from the leaf (the
 * last appended entry) to the root; with a compaction on it, the latest one's system checkpoint and
 * summary, the non-system entries from `firstKeptEntryId` up to it, and everything after it.
 * Messages are returned as Pi stores them (`AgentMessage`); the latest call is the one that
 * produced the last assistant message on the path, so its context is the path before it.
 *
 * Known gaps: `context_edit` entries are not applied, and the per-run memory, project
 * instructions and viewed file never reach the session. The file is on the workspace volume,
 * which the thread's tools can write: what it holds is data, like the rest of the context.
 */
/**
 * Most bytes of a session file read (its tail): the latest call's context is near the end, and the
 * agent's memory is shared by every thread. Past it, the older history is left out and the answer
 * says so (`historyCut`), unless a compaction inside the tail already replaced it.
 */
export const SESSION_TAIL_MAX_BYTES = 16 * 1024 * 1024;

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ReplayedCall {
  /** The file was longer than the tail read and the context needed what came before it. */
  readonly historyCut?: boolean;
  /** The messages the latest call was sent (no call yet: the whole context, `answer` null). */
  readonly messages: readonly unknown[];
  /** That call's answer (Pi's assistant message), or null when there was none. */
  readonly answer: Rec | null;
}

export interface Entry extends Rec {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
}

/**
 * The entries of a session file's last `maxBytes`, in append order (the header, torn lines and a
 * line cut by the tail's start skipped); `cut` says the file was longer.
 */
export async function readSessionEntries(
  file: string,
  maxBytes = SESSION_TAIL_MAX_BYTES,
): Promise<{ readonly entries: Entry[]; readonly cut: boolean } | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  const entries: Entry[] = [];
  let cut: boolean;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const start = Math.max(0, info.size - maxBytes);
    cut = start > 0;
    // From mid-file, the first (partial) line is not an entry.
    let skipFirst = cut;
    const splitter = new LineSplitter({
      maxLineBytes: PI_MAX_LINE_BYTES,
      onLine: (line) => {
        if (skipFirst) {
          skipFirst = false;
          return;
        }
        try {
          const record: unknown = JSON.parse(line);
          if (
            isRecord(record) &&
            typeof record.id === "string" &&
            typeof record.type === "string"
          ) {
            const parentId = typeof record.parentId === "string" ? record.parentId : null;
            entries.push({ ...record, id: record.id, parentId, type: record.type });
          }
        } catch {
          // a torn last line; Pi tolerates it too
        }
      },
    });
    const stream = handle.createReadStream({ autoClose: false, start, end: info.size - 1 });
    for await (const chunk of stream) splitter.push(chunk as Buffer);
    splitter.end();
  } finally {
    await handle.close();
  }
  return { entries, cut };
}

/** The active path, root first. */
export function pathToLeaf(entries: readonly Entry[]): Entry[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out: Entry[] = [];
  const seen = new Set<string>();
  for (let e = entries.at(-1); e !== undefined && !seen.has(e.id);) {
    seen.add(e.id);
    out.push(e);
    e = e.parentId === null ? undefined : byId.get(e.parentId);
  }
  return out.reverse();
}

const isSystem = (e: Entry): boolean =>
  e.type === "message" && isRecord(e.message) && e.message.role === "system";

function toMessages(entry: Entry): unknown[] {
  switch (entry.type) {
    case "message":
      return entry.message === undefined ? [] : [entry.message];
    case "compaction":
      return [
        ...(isRecord(entry.systemMessage) ? [entry.systemMessage] : []),
        { role: "compactionSummary", summary: entry.summary },
      ];
    case "branch_summary":
      return [{ role: "branchSummary", summary: entry.summary }];
    case "custom_message":
      return [{ role: "custom", customType: entry.customType, content: entry.content }];
    default:
      return [];
  }
}

/** The context messages of the path, honouring the latest compaction. */
export function contextOfPath(path: readonly Entry[]): unknown[] {
  let at = -1;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (path[i]?.type === "compaction") {
      at = i;
      break;
    }
  }
  if (at < 0) return path.flatMap(toMessages);
  const compaction = path[at] as Entry;
  const firstKept = path.findIndex((e) => e.id === compaction.firstKeptEntryId);
  const kept = firstKept < 0 || firstKept >= at ? [] : path.slice(firstKept, at);
  return [
    ...toMessages(compaction),
    ...kept.filter((e) => !isSystem(e)).flatMap(toMessages),
    ...path.slice(at + 1).flatMap(toMessages),
  ];
}

/**
 * The latest call: the last assistant message on the path is its answer, and its context is the
 * context of the path before it (a compaction after that answer is not part of it).
 */
export function latestCallOfPath(path: readonly Entry[]): ReplayedCall {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const entry = path[i] as Entry;
    const m = entry.type === "message" ? entry.message : undefined;
    if (isRecord(m) && m.role === "assistant") {
      return { messages: contextOfPath(path.slice(0, i)), answer: m };
    }
  }
  return { messages: contextOfPath(path), answer: null };
}

/**
 * Whether the context of `path` needed entries before it: the path does not reach the root, and
 * no compaction on it replaced what came before (its kept range starts inside the path).
 */
function needsOlder(path: readonly Entry[]): boolean {
  if (path.length === 0 || path[0]?.parentId === null) return false;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const e = path[i] as Entry;
    if (e.type !== "compaction") continue;
    return !path.slice(0, i + 1).some((k) => k.id === e.firstKeptEntryId);
  }
  return true;
}

/** The latest call from a session file, or undefined when there is no (readable) session. */
export async function replaySession(
  file: string,
  maxBytes = SESSION_TAIL_MAX_BYTES,
): Promise<ReplayedCall | undefined> {
  const read = await readSessionEntries(file, maxBytes);
  if (read === undefined) return undefined;
  const path = pathToLeaf(read.entries);
  const call = latestCallOfPath(path);
  if (!read.cut) return call;
  const answerAt =
    call.answer === null ? path.length : path.findIndex((e) => e.message === call.answer);
  return { ...call, historyCut: needsOlder(path.slice(0, Math.max(answerAt, 0))) };
}
