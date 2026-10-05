/**
 * Thread and run shapes as the web client sees them: the Thread API (KOBE-34), search (KOBE-33)
 * and the run orchestrator (KOBE-30) answer in snake_case; `apiRequest` camelizes every response,
 * except entry `payload`s (Pi documents, kept verbatim). Run events keep the `@kobe/protocol`
 * snake_case types: they arrive over SSE, not through `apiRequest`.
 */
import type {
  ApprovalResolutionCause,
  ApprovalStatus,
  JsonObject,
  PolicyReason,
  RiskClass,
  RunStatus,
  ThreadStatus,
} from "@kobe/protocol";

export interface ThreadSummary {
  readonly threadId: string;
  readonly title: string | null;
  readonly status: ThreadStatus;
  readonly ownerUserId: string;
  readonly projectId: string | null;
  readonly agentId: string | null;
  readonly agentVersion: number | null;
  /** The pinned agent's name and its state in this team (KOBE-122); null without an agent. */
  readonly agentName?: string | null;
  readonly agentStatus?: "active" | "suspended" | "archived" | null;
  readonly sharedToProject: boolean;
  /** A builder test thread (KOBE-85); never in the lists the chat shows. */
  readonly isTest?: boolean;
  /** The model chosen for the thread (a catalog alias); null = the team's default (KOBE-44). */
  readonly model?: string | null;
  readonly leafEntryId: string | null;
  readonly lastActivityAt: string;
  readonly createdAt: string;
  /** Set while the thread is in Trash. */
  readonly deletedAt: string | null;
  /** When the Trash purge may remove it (deleted + 30 days). */
  readonly purgeAfter: string | null;
}

/** An agent the user can start a chat with (`GET /v1/agents/runnable`, KOBE-122). */
export interface RunnableAgent {
  readonly id: string;
  readonly scope: "team" | "personal" | "gallery";
  readonly name: string;
  readonly description?: string;
  /** The model the agent's current version pins (alias or id); null = not pinned. */
  readonly model: string | null;
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
  /** The model the thread's agent pins (KOBE-44/47); it wins over `model`. Null: no pin. */
  readonly agentModel?: string | null;
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
  /**
   * The queue is held after Stop until the user resumes or sends (Chris's D17 decision; the server
   * side lands with KOBE-26 — `queue_paused` is the expected field, absent on older servers).
   */
  readonly queuePaused?: boolean | undefined;
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

/** An approval as `GET`/`POST /v1/approvals/{id}` answer it (KOBE-37), camelized. */
export interface ApprovalView {
  readonly approvalId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly tool: string;
  /** The checked input (keys camelized by the client: show `input` from the event when present). */
  readonly input: JsonObject;
  readonly risk: RiskClass;
  readonly reasons: readonly PolicyReason[];
  readonly status: ApprovalStatus;
  readonly cause: ApprovalResolutionCause | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly remembered: boolean;
}

export interface ApprovalDecisionBody {
  readonly decision: "allow" | "deny";
  /** "Always allow this tool": a remember-rule for exactly this tool, optionally expiring. */
  readonly remember?: { readonly toolGlob: string; readonly expiresIn?: number | undefined };
}

/** A member's request to enable a blocked egress domain (KOBE-39, `/v1/egress/requests`). */
export interface EgressRequest {
  readonly id: string;
  /** The host that was blocked. */
  readonly domain: string;
  /** The ceiling pattern approving it enables. */
  readonly pattern: string;
  readonly status: "pending" | "approved" | "denied";
  readonly threadId: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}
