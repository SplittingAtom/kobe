/**
 * Thread and run shapes as the web client sees them: the Thread API (KOBE-34), search (KOBE-33)
 * and the run orchestrator (KOBE-30) answer in snake_case; `apiRequest` camelizes every response,
 * except entry `payload`s (Pi documents, kept verbatim). Run events keep the `@kobe/protocol`
 * snake_case types: they arrive over SSE, not through `apiRequest`.
 */
import type { RunStatus, ThreadStatus } from "@kobe/protocol";

export interface ThreadSummary {
  readonly threadId: string;
  readonly title: string | null;
  readonly status: ThreadStatus;
  readonly ownerUserId: string;
  readonly projectId: string | null;
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  readonly sharedToProject: boolean;
  readonly leafEntryId: string | null;
  readonly lastActivityAt: string;
  readonly createdAt: string;
  /** Set while the thread is in Trash. */
  readonly deletedAt: string | null;
  /** When the Trash purge may remove it (deleted + 30 days). */
  readonly purgeAfter: string | null;
}

export interface ThreadPage {
  readonly threads: readonly ThreadSummary[];
  readonly nextCursor: string | null;
}

export interface SnippetSegment {
  readonly text: string;
  readonly highlight: boolean;
}

export interface ThreadSearchHit extends ThreadSummary {
  readonly matchedEntryId: string | null;
  readonly snippet: readonly SnippetSegment[] | null;
  readonly score: number;
}

export interface ThreadSearchPage {
  readonly threads: readonly ThreadSearchHit[];
  readonly nextCursor: string | null;
}

/** One Pi session entry mirrored into `thread_entries` (D15). */
export interface ThreadEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly seq: number;
  /** Pi entry type (`message`, `compaction`, `branch_summary`, `model_change`, …). */
  readonly type: string;
  /** The Pi entry as stored (untrusted agent output; parsed defensively in `entries.ts`). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The body lives in object storage (over 64 KB, D15); `payload` is empty. */
  readonly payloadOffloaded: boolean;
  readonly createdAt: string;
}

export interface ThreadDetail extends ThreadSummary {
  readonly agentCurrentVersion: number | null;
  readonly entries: readonly ThreadEntry[];
  readonly nextEntriesAfter: number | null;
}

export interface EntryPage {
  readonly entries: readonly ThreadEntry[];
  readonly nextEntriesAfter: number | null;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly threadId: string;
  readonly status: RunStatus;
  readonly trigger: "user" | "schedule";
  /** 1 = next; only while queued. */
  readonly queuePos?: number | undefined;
  readonly retryOfRunId?: string | undefined;
  readonly userEntryId?: string | undefined;
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
}

/** `GET /v1/threads/{id}/runs`: the active run, then queued runs; the run an interrupted thread waits on. */
export interface ThreadRuns {
  readonly runs: readonly RunSnapshot[];
  readonly interruptedRun: RunSnapshot | null;
}

/**
 * `GET /v1/threads/{id}/pending-messages` (KOBE-32): the text of messages that are not in the
 * entry tree yet: queued runs (editable) and the active run's prompt until Pi commits it.
 */
export interface PendingMessage {
  readonly runId: string;
  readonly status: RunStatus;
  readonly queuePos?: number | undefined;
  readonly content: string;
  readonly parentEntryId: string | null;
}

export interface PendingMessages {
  readonly messages: readonly PendingMessage[];
}

export interface SubmitResult {
  readonly runId: string;
  readonly queued: boolean;
}
