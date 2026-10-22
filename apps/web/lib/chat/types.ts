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
  RememberScope,
  RiskClass,
  RunStatus,
  ThinkingLevel,
  ThreadStatus,
} from "@kobe/protocol";

/** `GET /v1/threads/{id}/card` (CE18, KOBE-219), camelized: the rail's hover card. */
export interface ThreadCard {
  readonly threadId: string;
  /** The first user message, whitespace collapsed, cut to 280 characters; null: none yet. */
  readonly firstMessage: string | null;
  readonly firstMessageTruncated: boolean;
  readonly agentId: string | null;
  /** Null for the default agent, or an agent no longer available. */
  readonly agentName: string | null;
  readonly lastActivityAt: string;
  /** The member's messages and the agent's answers (tool-only turns not counted). */
  readonly messageCount: number;
  /** The server stopped counting: the thread holds more ("1000+"); absent on older servers. */
  readonly messageCountCapped?: boolean;
}

/** `GET /v1/threads/activity` (KOBE-301), camelized: threads not listed are idle. */
export interface ThreadActivityList {
  readonly threads: readonly {
    readonly threadId: string;
    readonly activity: "running" | "approval";
  }[];
}

/** Who reads a thread (D23, CE20): its owner only, its project's members, or the whole team. */
export type ThreadVisibility = "private" | "project" | "team";

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
  /** The pinned version is an admin's Dangerous agent (KOBE-476): its tools run without asking. */
  readonly agentDangerous?: boolean;
  readonly sharedToProject: boolean;
  /**
   * `private`, `project` (KOBE-163) or `team` (KOBE-221); absent on older answers = see
   * `sharedToProject`.
   */
  readonly visibility?: ThreadVisibility;
  /** True for a thread shared to you by someone else: you read and fork it, nothing else. */
  readonly readOnly?: boolean;
  /** For a reader: who shared it ("Shared by …"); null once they left the team (KOBE-221). */
  readonly ownerName?: string | null;
  /**
   * An approval waits for the caller on this thread (KOBE-301; pending, unexpired, on their run):
   * the rail's amber dot. Absent otherwise, and on older servers.
   */
  readonly pendingApproval?: boolean;
  /** A builder test thread (KOBE-85); never in the lists the chat shows. */
  readonly isTest?: boolean;
  /**
   * A Workbench test chat (KOBE-323): listed in the rail's Workbench group; its runs load only the
   * draft `skillDraftId` (null once the draft is deleted).
   */
  readonly skillTest?: boolean;
  readonly skillDraftId?: string | null;
  /** The model chosen for the thread (a catalog alias); null = the team's default (KOBE-44). */
  readonly model?: string | null;
  /** The thinking level chosen for the thread (KOBE-260); null or absent = the model's default. */
  readonly thinkingLevel?: ThinkingLevel | null;
  /** Set when a schedule started the thread (KOBE-173); drives the Scheduled folder. */
  readonly scheduleId?: string | null;
  /**
   * Fork provenance (CE16, KOBE-216). The source's id and title only while you may open it;
   * `forkedAtEntryId` is an entry of this thread itself (set on every fork, kept after the source
   * is gone). A fork point without a source: "forked from a thread you can't open".
   */
  readonly forkedFromThreadId?: string | null;
  readonly forkedFromTitle?: string | null;
  readonly forkedAtEntryId?: string | null;
  /**
   * The owner's organization (CE19, KOBE-220): pinned (the rail's Pinned group) or archived (the
   * Archived group, still found by search); never both. Absent on older answers: neither.
   */
  readonly pinnedAt?: string | null;
  readonly archivedAt?: string | null;
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
  /** Stable key of a gallery agent (e.g. "kobe"); absent for team and personal agents. */
  readonly galleryKey?: string;
  /** The agent a new conversation starts with (the server's rule, KOBE-458); one at most. */
  readonly default?: true;
  /** Unique within its scope (team, the user's personal agents, the gallery). */
  readonly slug?: string;
  readonly name: string;
  readonly description?: string;
  /** The model the agent's current version pins (alias or id); null = not pinned. */
  readonly model: string | null;
  /** The current version's conversation starters (D19): the welcome screen's chips (KOBE-222). */
  readonly starters?: readonly string[];
  /** The current version is an admin's Dangerous agent (KOBE-476): badged in the picker. */
  readonly dangerous?: true;
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
  /** A tool output over 64 KB cut to a preview (KOBE-208); the full one via `toolOutput`. */
  readonly payloadTruncated?: boolean | undefined;
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
  /**
   * "Remember": a rule for exactly this tool with a scope (KOBE-289). `exact` pins this action;
   * the server derives the pattern and the expiry itself and refuses what the team's limits don't
   * allow.
   */
  readonly remember?: {
    readonly toolGlob: string;
    readonly scope: RememberScope;
    readonly exact?: boolean | undefined;
  };
}

/** `GET /v1/approvals/{id}/remember` (KOBE-289): what the card may offer, as the server decided. */
export interface RememberOptions {
  readonly approvalId: string;
  readonly runId: string;
  readonly canRemember: boolean;
  readonly reason: string | null;
  readonly choices: readonly {
    readonly scope: RememberScope;
    readonly label: string;
    readonly expiresAt: string | null;
  }[];
  readonly timeZone: string;
  /** The exact-action pattern (JSON pointer → literal glob), kept verbatim. */
  readonly exact: {
    readonly argPattern: Readonly<Record<string, string>>;
    /** Every argument pinned (true), or only a file tool's path (false: the content may differ). */
    readonly pinsAll: boolean;
  } | null;
  readonly exactOnly: boolean;
  readonly approveAll: { readonly approvalIds: readonly string[] } | null;
  readonly approveAllReason: string | null;
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
