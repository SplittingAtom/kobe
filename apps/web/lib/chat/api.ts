/**
 * Chat resources over the shared API client (`lib/api/client.ts`). Every call is team-scoped and
 * sends `X-Kobe-Team`, reads included, so a tab left on another team gets `team_mismatch` instead of
 * acting on the wrong team. Request bodies use the routes' snake_case (spec §6.1).
 */
import type { appContextBody } from "../apps/app-context";

/** One `app_context` part as sent (KOBE-439). */
export type AppContextWire = ReturnType<typeof appContextBody>[number];
import type { ItemReference, MessageViewing, ThinkingLevel } from "@kobe/protocol";
import type { FileEntry } from "../files/api";
import type { ProposalView } from "../files/editor-state";
import { apiDownload, apiRequest, apiTextFile, type ApiResult, type TextFile } from "../api/client";
import { readThreadContext, type ContextRead } from "./context-viewer";
import type { ArtifactDetailView, ArtifactSummaryView } from "./artifacts";
import type { BudgetStatus } from "../admin/api/budgets";
import type { RunUsage, ThreadUsage } from "../admin/api/usage";
import { listTeamModels, type TeamModels } from "../admin/api/team/models";
import { createMemoryApi } from "../memory/api";
import {
  feedbackBody,
  type AnswerFeedback,
  type FeedbackChange,
  type ThreadFeedback,
} from "./feedback";
import {
  evalCaseOptionsBody,
  type EvalCaseOptions,
  type EvalCasePreview,
  type MyEvalCase,
} from "./eval-cases";
import type { ThreadMarkers } from "./markers";
import type {
  ApprovalDecisionBody,
  ApprovalView,
  RememberOptions,
  EgressRequest,
  EntryPage,
  PendingMessages,
  RunnableAgent,
  RunSnapshot,
  SubmitResult,
  ThreadActivityList,
  ThreadCard,
  ThreadDetail,
  ThreadPage,
  ThreadRuns,
  ThreadSearchPage,
  ThreadSummary,
  ThreadVisibility,
} from "./types";

const enc = encodeURIComponent;

function query(params: Readonly<Record<string, string | number | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

/** `POST /v1/threads/{id}/compact`'s answer (camelized; KOBE-212 contract). */
export interface CompactResult {
  readonly threadId: string;
  /** Absent when it is too large to echo; the `compaction` entry has it. */
  readonly summary?: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly estimatedTokensAfter?: number;
}

/** What the chat shows of the team's retention (`GET /v1/team/retention`, camelized). */
export interface TeamRetentionNotice {
  readonly upcoming: { readonly period: string; readonly effectiveAt: string } | null;
}

/**
 * The rail reads this many pinned and archived threads (CE19): one page each, the most recent.
 * Older archived threads are found by search.
 */
export const ORGANIZED_PAGE = 100;

const RUNNABLE_PAGE_SIZE = 200;
/** A guard, not a limit anyone reaches: 10 pages of 200. */
const RUNNABLE_MAX_PAGES = 10;

interface RunnablePage {
  readonly agents: readonly RunnableAgent[];
  readonly nextCursor: string | null;
}

/** `GET /v1/threads/{id}/entries/{entryId}/output`: a tool result's full output (KOBE-208). */
export interface ToolOutput {
  readonly entryId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly text: string;
  /** Longer than the server answers; `text` is its start. */
  readonly truncated: boolean;
}

export interface ChatApi {
  listThreads(cursor?: string): Promise<ApiResult<ThreadPage>>;
  searchThreads(
    q: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<ApiResult<ThreadSearchPage>>;
  listTrash(cursor?: string): Promise<ApiResult<ThreadPage>>;
  /** The caller's pinned threads, newest pin first (CE19, KOBE-220). */
  listPinned(): Promise<ApiResult<ThreadPage>>;
  /** The caller's archived threads, most recently archived first (CE19). */
  listArchived(): Promise<ApiResult<ThreadPage>>;
  /** Others' threads shared with the caller, newest activity first (CE20, KOBE-221). */
  listShared(): Promise<ApiResult<ThreadPage>>;
  /** Pin, unpin, archive or unarchive one of the caller's threads (CE19); idempotent. */
  organizeThread(
    threadId: string,
    action: "pin" | "unpin" | "archive" | "unarchive",
  ): Promise<ApiResult<ThreadSummary>>;
  /** Moves the thread to a project the caller may start threads in, or out (null; CE19). */
  moveThread(threadId: string, projectId: string | null): Promise<ApiResult<ThreadSummary>>;
  /** A new thread; `model` is an enabled alias, or null/absent for the team default (KOBE-44). */
  createThread(
    title?: string,
    model?: string | null,
    agent?: { readonly agentId: string; readonly test: boolean },
    projectId?: string | null,
    /** The conversation's thinking level (KOBE-260); null/absent = the model's default. */
    thinkingLevel?: ThinkingLevel | null,
    /** A Workbench test chat (KOBE-323): the Kobe agent on this draft; `agent` is then left out. */
    skillDraftId?: string,
    /** Connectors off from the start (KOBE-451): checked by the server like the toggle. */
    connectorsOff?: readonly string[],
  ): Promise<ApiResult<ThreadSummary>>;
  /** Shares the thread with its project or the team, or makes it private (owner only; CE20). */
  shareThread(threadId: string, visibility: ThreadVisibility): Promise<ApiResult<ThreadSummary>>;
  /**
   * Copies the thread into a new private thread of yours (`POST /v1/threads/:id/fork`): its
   * entries up to `entryId` (default: the leaf), titled `title` (default: the source's).
   */
  forkThread(
    threadId: string,
    options?: ForkOptions,
  ): Promise<ApiResult<{ readonly threadId: string }>>;
  /** Agents the user can start a chat with in this team, every page (KOBE-122). */
  runnableAgents(): Promise<ApiResult<readonly RunnableAgent[]>>;
  /** Clears the caller's builder test threads of one agent (KOBE-85); they go to Trash, hidden. */
  clearTestThreads(agentId: string): Promise<ApiResult<{ readonly cleared: number }>>;
  /** Sets the thread's model for its next runs (an enabled alias; null = the team default). */
  setThreadModel(threadId: string, model: string | null): Promise<ApiResult<ThreadSummary>>;
  /**
   * Moves the thread to another version of its agent (D19, U8): `version`, or the agent's current
   * one when absent (`POST /v1/threads/:id/agent-version`). The owner's own; refused while a run is
   * active (`thread_busy`).
   */
  switchAgentVersion(threadId: string, version?: number): Promise<ApiResult<ThreadSummary>>;
  /**
   * Gives an agentless thread an agent, at its current version (`POST /v1/threads/:id/agent`,
   * KOBE-458). The owner's own; once only (`agent_already_chosen`); refused while a run is active.
   */
  chooseThreadAgent(threadId: string, agentId: string): Promise<ApiResult<ThreadSummary>>;
  /** Sets the thread's thinking level for its next runs (KOBE-260; null = the model's default). */
  setThreadThinking(
    threadId: string,
    level: ThinkingLevel | null,
  ): Promise<ApiResult<ThreadSummary>>;
  /** The site catalog with the team's enabled models and default (`GET /v1/team/models`). */
  listModels(): Promise<ApiResult<TeamModels>>;
  /** The thread with its entries after `after` (0 = from the start). */
  getThread(threadId: string, after?: number): Promise<ApiResult<ThreadDetail>>;
  /** The thread without its entries (the thread list's `fetch`). */
  threadSummary(threadId: string): Promise<ApiResult<ThreadSummary>>;
  /** The rail's hover card (CE18, KOBE-219): first message, agent, last activity, count. */
  threadCard(threadId: string): Promise<ApiResult<ThreadCard>>;
  /** The caller's own threads with a run going or an approval waiting (KOBE-301, the rail). */
  threadActivity(): Promise<ApiResult<ThreadActivityList>>;
  listEntries(threadId: string, after: number): Promise<ApiResult<EntryPage>>;
  renameThread(threadId: string, title: string | null): Promise<ApiResult<ThreadSummary>>;
  trashThread(threadId: string): Promise<ApiResult<ThreadSummary>>;
  restoreThread(threadId: string): Promise<ApiResult<ThreadSummary>>;
  /** The team's retention period and any upcoming shortening (KOBE-18 banner). */
  retention(): Promise<ApiResult<TeamRetentionNotice>>;
  /** "Delete forever" from Trash (D18, KOBE-18): the owner only; 204. */
  purgeThread(threadId: string): Promise<ApiResult<void>>;
  setLeaf(threadId: string, entryId: string): Promise<ApiResult<ThreadSummary>>;
  /**
   * Compact now (CE15, KOBE-213): Pi summarizes the idle thread's older conversation, with an
   * optional one-line focus. Answers once done; the `compaction` entry is then in the thread.
   */
  compactThread(threadId: string, focus?: string): Promise<ApiResult<CompactResult>>;
  sendMessage(
    threadId: string,
    body: {
      readonly content: string;
      readonly parentEntryId?: string | undefined;
      readonly fileIds?: readonly string[] | undefined;
      /** Workspace paths picked with `@` (KOBE-223): only their markers are rewritten. */
      readonly mentions?: readonly string[] | undefined;
      /** MCP Apps context chips, wire casing (KOBE-439). */
      readonly appContext?: readonly AppContextWire[] | undefined;
      /** A skill picked from the composer's + menu (KOBE-451). */
      readonly skill?: string | undefined;
      /** The workspace file open in the artifact column (KOBE-463, FE7). */
      readonly viewing?: MessageViewing | undefined;
      /** Regenerate: the prompt entry whose run's viewed file is read again (KOBE-467). */
      readonly viewingFromEntry?: string | undefined;
      /** Items an app put in the composer as chips (KOBE-490). */
      readonly references?: readonly ItemReference[] | undefined;
    },
    idempotencyKey: string,
  ): Promise<ApiResult<SubmitResult>>;
  listRuns(threadId: string): Promise<ApiResult<ThreadRuns>>;
  pendingMessages(threadId: string): Promise<ApiResult<PendingMessages>>;
  resumeQueue(threadId: string): Promise<ApiResult<ThreadRuns>>;
  /** Holds the queued messages until resumed or a new message (CE10, KOBE-206). */
  pauseQueue(threadId: string): Promise<ApiResult<ThreadRuns>>;
  /** The whole queue in its new order; 409 `queue_changed` when the list is stale. */
  reorderQueue(threadId: string, runIds: readonly string[]): Promise<ApiResult<ThreadRuns>>;
  getRun(runId: string): Promise<ApiResult<RunSnapshot>>;
  editQueued(runId: string, content: string): Promise<ApiResult<RunSnapshot>>;
  steer(
    runId: string,
    content: string,
    mentions?: readonly string[],
  ): Promise<ApiResult<RunSnapshot>>;
  cancel(runId: string): Promise<ApiResult<RunSnapshot>>;
  retry(runId: string): Promise<ApiResult<SubmitResult>>;
  /** Tokens and spend of one run (KOBE-43), as the model gateway measured them. */
  runUsage(runId: string): Promise<ApiResult<RunUsage>>;
  /** Tokens and spend of each run of a thread (the answers' footers, KOBE-208). */
  threadUsage(threadId: string): Promise<ApiResult<ThreadUsage>>;
  /** What the thread's latest model call sent the model (KOBE-470/471), read live; owner only. */
  threadContext(threadId: string): Promise<ContextRead>;
  /** Interrupted and budget-stopped runs and decided approvals (inline markers, KOBE-209). */
  threadMarkers(threadId: string): Promise<ApiResult<ThreadMarkers>>;
  /** The thread's rateable answers with the caller's own ratings (KOBE-275). */
  threadFeedback(threadId: string): Promise<ApiResult<ThreadFeedback>>;
  /** Rates an answer, or changes the caller's rating of it (KOBE-275). */
  rateAnswer(runId: string, change: FeedbackChange): Promise<ApiResult<AnswerFeedback>>;
  /** Clears the caller's rating of an answer (KOBE-275); 204 also when there was none. */
  clearRating(runId: string): Promise<ApiResult<undefined>>;
  /** What sharing a rated-down answer as an eval case would store (KOBE-276); shares nothing. */
  previewEvalCase(runId: string, options: EvalCaseOptions): Promise<ApiResult<EvalCasePreview>>;
  /** Shares it as previewed (the preview's digest), with the agent's owner (KOBE-276). */
  shareEvalCase(
    runId: string,
    options: EvalCaseOptions,
    digest: string,
  ): Promise<ApiResult<MyEvalCase>>;
  /** Withdraws the caller's case: the copy is deleted (KOBE-276); 204 also when there was none. */
  withdrawEvalCase(caseId: string): Promise<ApiResult<undefined>>;
  /** A tool result's full output, trimmed in the entry list or offloaded (KOBE-208). */
  toolOutput(threadId: string, entryId: string): Promise<ApiResult<ToolOutput>>;
  /** The member's budgets and how much is used (KOBE-42: the 80 % warning, the 100 % stop). */
  budgetStatus(): Promise<ApiResult<BudgetStatus>>;
  /** One of your approvals with its full input (KOBE-37). */
  getApproval(approvalId: string): Promise<ApiResult<ApprovalView>>;
  /** `POST /v1/approvals/{id}` (§6.1): allow or deny, optionally remembering an allow. */
  decideApproval(approvalId: string, body: ApprovalDecisionBody): Promise<ApiResult<ApprovalView>>;
  /** What the card may offer for a pending approval (KOBE-289; the server decides it). */
  rememberOptions(approvalId: string): Promise<ApiResult<RememberOptions>>;
  /** "Approve all waiting" (KOBE-289): each listed approval of the run, signed on its own. */
  approveAll(
    runId: string,
    approvalIds: readonly string[],
  ): Promise<ApiResult<{ readonly approvals: readonly ApprovalView[] }>>;
  /**
   * Request access (KOBE-39): ask the team's admins to enable a blocked domain (`POST
   * /v1/egress/requests`); 201 new, 200 already pending, 409 `already_enabled`/`not_in_ceiling`.
   */
  requestEgressAccess(
    domain: string,
    threadId: string | undefined,
  ): Promise<ApiResult<{ readonly request: EgressRequest }>>;
  /** The artifacts of a thread (`GET /v1/artifacts?thread_id=`, KOBE-55), to reopen them. */
  listArtifacts(
    threadId: string,
  ): Promise<ApiResult<{ readonly artifacts: readonly ArtifactSummaryView[] }>>;
  /** One artifact with its versions. */
  getArtifact(artifactId: string): Promise<ApiResult<ArtifactDetailView>>;
  /** The bytes of one version as text, for the panel's renderers. */
  artifactContent(artifactId: string, version: number): Promise<ApiResult<TextFile>>;
  /**
   * Edit as file (KOBE-485): the server copies the version into the caller's workspace as
   * `artifacts/<slug>.<ext>` (`-2`, `-3` … on a clash) and answers the new file. Thread owner only.
   */
  artifactEditAsFile(artifactId: string, version: number): Promise<ApiResult<FileEntry>>;
  /**
   * The thread's `propose_file_edit` proposals as the server recorded them (KOBE-462, FE9; the
   * owner only), oldest first: the proposal cards after a reload.
   */
  fileEditProposals(threadId: string): Promise<ApiResult<readonly ProposalView[]>>;
  /**
   * The workspace files the agent wrote in the thread and that still exist (KOBE-488, `GET
   * /v1/threads/{id}/files`; the owner only, 404 for anyone else), in order of first appearance.
   */
  threadFiles(threadId: string): Promise<ApiResult<readonly FileEntry[]>>;
  /** The bytes of a file the agent shared (`GET /v1/files/:id/content`, KOBE-150). */
  downloadSharedFile(fileId: string): Promise<ApiResult<Uint8Array>>;
  /**
   * Undo of a `memory.updated` (KOBE-158): restores `version` (a new version with the old content)
   * or, for a doc the write created, deletes it (`undoMemoryAction`).
   */
  undoMemory(
    docId: string,
    action:
      { readonly action: "restore"; readonly version: number } | { readonly action: "delete" },
  ): Promise<ApiResult<unknown>>;
  /** Your own requests for one domain, newest first. */
  egressRequests(
    domain: string,
  ): Promise<ApiResult<{ readonly requests: readonly EgressRequest[] }>>;
}

/** Where a fork ends and what it is called (CE16); both optional. */
export interface ForkOptions {
  readonly entryId?: string;
  readonly title?: string;
}

/** The chat API for one team; `teamId` goes in `X-Kobe-Team` on every request. */
export function createChatApi(teamId: string, fetchFn?: typeof fetch): ChatApi {
  const get = <T>(path: string) => apiRequest<T>(path, { teamId, fetchFn });
  const memory = createMemoryApi(teamId, fetchFn);
  const send = <T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, json?: unknown) =>
    apiRequest<T>(path, { method, json, teamId, fetchFn });

  return {
    listThreads: (cursor) => get(`/v1/threads${query({ cursor })}`),
    searchThreads: (q, cursor, signal) =>
      apiRequest(`/v1/threads${query({ q, cursor })}`, { teamId, fetchFn, signal }),
    listTrash: (cursor) => get(`/v1/threads/trash${query({ cursor })}`),
    listPinned: () => get(`/v1/threads/pinned${query({ limit: ORGANIZED_PAGE })}`),
    listArchived: () => get(`/v1/threads/archived${query({ limit: ORGANIZED_PAGE })}`),
    listShared: () => get(`/v1/threads/shared${query({ limit: ORGANIZED_PAGE })}`),
    organizeThread: (id, action) => send("POST", `/v1/threads/${enc(id)}/${action}`),
    moveThread: (id, projectId) =>
      send("POST", `/v1/threads/${enc(id)}/move`, { project_id: projectId }),
    shareThread: (id, visibility) => send("POST", `/v1/threads/${enc(id)}/share`, { visibility }),
    forkThread: (id, options = {}) =>
      send("POST", `/v1/threads/${enc(id)}/fork`, {
        ...(options.entryId === undefined ? {} : { entry_id: options.entryId }),
        ...(options.title === undefined ? {} : { title: options.title }),
      }),
    createThread: (title, model, agent, projectId, thinkingLevel, skillDraftId, connectorsOff) =>
      send("POST", "/v1/threads", {
        ...(connectorsOff === undefined || connectorsOff.length === 0
          ? {}
          : { connectors_off: connectorsOff }),
        ...(skillDraftId === undefined ? {} : { skill_draft_id: skillDraftId }),
        ...(projectId === undefined || projectId === null ? {} : { project_id: projectId }),
        ...(title === undefined ? {} : { title }),
        ...(model === undefined || model === null ? {} : { model }),
        ...(thinkingLevel === undefined || thinkingLevel === null
          ? {}
          : { thinking_level: thinkingLevel }),
        ...(agent === undefined
          ? {}
          : { agent_id: agent.agentId, ...(agent.test ? { test: true } : {}) }),
      }),
    runnableAgents: async () => {
      const agents: RunnableAgent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < RUNNABLE_MAX_PAGES; page += 1) {
        const res = await get<RunnablePage>(
          `/v1/agents/runnable${query({ limit: RUNNABLE_PAGE_SIZE, cursor })}`,
        );
        if (!res.ok) return { ok: false, error: res.error };
        agents.push(...res.data.agents);
        if (res.data.nextCursor === null) break;
        cursor = res.data.nextCursor;
      }
      return { ok: true, status: 200, data: agents };
    },
    clearTestThreads: (agentId) =>
      send("DELETE", `/v1/threads/test${query({ agent_id: agentId })}`),
    setThreadModel: (id, model) => send("PATCH", `/v1/threads/${enc(id)}`, { model }),
    switchAgentVersion: (id, version) =>
      send(
        "POST",
        `/v1/threads/${enc(id)}/agent-version`,
        version === undefined ? {} : { version },
      ),
    chooseThreadAgent: (id, agentId) =>
      send("POST", `/v1/threads/${enc(id)}/agent`, { agent_id: agentId }),
    setThreadThinking: (id, level) =>
      send("PATCH", `/v1/threads/${enc(id)}`, { thinking_level: level }),
    listModels: () => listTeamModels(teamId, fetchFn),
    getThread: (id, after = 0) =>
      get(`/v1/threads/${enc(id)}${query({ after: after > 0 ? after : undefined, limit: 500 })}`),
    threadSummary: (id) => get(`/v1/threads/${enc(id)}${query({ limit: 1 })}`),
    threadCard: (id) => get(`/v1/threads/${enc(id)}/card`),
    threadActivity: () => get("/v1/threads/activity"),
    listEntries: (id, after) =>
      get(`/v1/threads/${enc(id)}/entries${query({ after, limit: 500 })}`),
    renameThread: (id, title) => send("PATCH", `/v1/threads/${enc(id)}`, { title }),
    trashThread: (id) => send("DELETE", `/v1/threads/${enc(id)}`),
    restoreThread: (id) => send("POST", `/v1/threads/${enc(id)}/restore`),
    purgeThread: (id) => send("POST", `/v1/threads/${enc(id)}/purge`),
    retention: () => get("/v1/team/retention"),
    setLeaf: (id, entryId) => send("POST", `/v1/threads/${enc(id)}/leaf`, { entry_id: entryId }),
    compactThread: (id, focus) =>
      send("POST", `/v1/threads/${enc(id)}/compact`, focus === undefined ? {} : { focus }),
    sendMessage: (id, body, idempotencyKey) =>
      apiRequest(`/v1/threads/${enc(id)}/messages`, {
        method: "POST",
        json: {
          content: body.content,
          ...(body.parentEntryId === undefined ? {} : { parent_entry_id: body.parentEntryId }),
          ...(body.fileIds === undefined || body.fileIds.length === 0
            ? {}
            : { file_ids: body.fileIds }),
          ...(body.mentions === undefined || body.mentions.length === 0
            ? {}
            : { mentions: body.mentions }),
          ...(body.appContext === undefined || body.appContext.length === 0
            ? {}
            : { app_context: body.appContext }),
          ...(body.skill === undefined ? {} : { skill: body.skill }),
          ...(body.viewing === undefined ? {} : { viewing: body.viewing }),
          ...(body.viewingFromEntry === undefined
            ? {}
            : { viewing_from_entry: body.viewingFromEntry }),
          ...(body.references === undefined || body.references.length === 0
            ? {}
            : { references: body.references }),
        },
        teamId,
        idempotencyKey,
        fetchFn,
      }),
    listRuns: (id) => get(`/v1/threads/${enc(id)}/runs`),
    pendingMessages: (id) => get(`/v1/threads/${enc(id)}/pending-messages`),
    resumeQueue: (id) => send("POST", `/v1/threads/${enc(id)}/queue/resume`),
    pauseQueue: (id) => send("POST", `/v1/threads/${enc(id)}/queue/pause`),
    reorderQueue: (id, runIds) =>
      send("POST", `/v1/threads/${enc(id)}/queue/order`, { run_ids: runIds }),
    getRun: (runId) => get(`/v1/runs/${enc(runId)}`),
    editQueued: (runId, content) => send("PATCH", `/v1/runs/${enc(runId)}`, { content }),
    steer: (runId, content, mentions) =>
      send(
        "POST",
        `/v1/runs/${enc(runId)}/steer`,
        mentions === undefined || mentions.length === 0 ? { content } : { content, mentions },
      ),
    cancel: (runId) => send("POST", `/v1/runs/${enc(runId)}/cancel`),
    retry: (runId) => send("POST", `/v1/runs/${enc(runId)}/retry`),
    runUsage: (runId) => get(`/v1/runs/${enc(runId)}/usage`),
    threadUsage: (id) => get(`/v1/threads/${enc(id)}/usage`),
    threadContext: (id) => readThreadContext(id, teamId, fetchFn),
    threadMarkers: (id) => get(`/v1/threads/${enc(id)}/markers`),
    threadFeedback: (id) => get(`/v1/threads/${enc(id)}/feedback`),
    rateAnswer: (runId, change) =>
      send("PUT", `/v1/runs/${enc(runId)}/feedback`, feedbackBody(change)),
    clearRating: (runId) => send("DELETE", `/v1/runs/${enc(runId)}/feedback`),
    previewEvalCase: (runId, options) =>
      send("POST", `/v1/runs/${enc(runId)}/eval-case/preview`, evalCaseOptionsBody(options)),
    shareEvalCase: (runId, options, digest) =>
      send("POST", `/v1/runs/${enc(runId)}/eval-case`, { ...evalCaseOptionsBody(options), digest }),
    withdrawEvalCase: (caseId) => send("DELETE", `/v1/eval-cases/${enc(caseId)}`),
    toolOutput: (id, entryId) => get(`/v1/threads/${enc(id)}/entries/${enc(entryId)}/output`),
    budgetStatus: () => get("/v1/team/budgets/status"),
    getApproval: (id) => get(`/v1/approvals/${enc(id)}`),
    requestEgressAccess: (domain, threadId) =>
      send("POST", "/v1/egress/requests", {
        domain,
        ...(threadId === undefined ? {} : { thread_id: threadId }),
      }),
    listArtifacts: (threadId) => get(`/v1/artifacts${query({ thread_id: threadId })}`),
    getArtifact: (id) => get(`/v1/artifacts/${enc(id)}`),
    artifactContent: (id, version) =>
      apiTextFile(`/v1/artifacts/${enc(id)}/versions/${version}/content`, { teamId, fetchFn }),
    artifactEditAsFile: (id, version) =>
      send("POST", `/v1/artifacts/${enc(id)}/versions/${version}/edit-as-file`),
    fileEditProposals: async (id) => {
      const res = await get<{ proposals: readonly (ProposalView & Record<string, unknown>)[] }>(
        `/v1/threads/${enc(id)}/file-edit-proposals`,
      );
      if (!res.ok) return res;
      const proposals = res.data.proposals.map(
        ({ toolCallId, path, baseSha256, content, summary }) => ({
          toolCallId,
          path,
          baseSha256,
          content,
          summary,
        }),
      );
      return { ...res, data: proposals };
    },
    threadFiles: async (id) => {
      const res = await get<{ files: readonly FileEntry[] }>(`/v1/threads/${enc(id)}/files`);
      return res.ok ? { ...res, data: res.data.files } : res;
    },
    downloadSharedFile: (id) => apiDownload(`/v1/files/${enc(id)}/content`, { teamId, fetchFn }),
    undoMemory: (docId, action) =>
      action.action === "restore" ? memory.restore(docId, action.version) : memory.remove(docId),
    egressRequests: (domain) => get(`/v1/egress/requests${query({ domain })}`),
    decideApproval: (id, body) =>
      send("POST", `/v1/approvals/${enc(id)}`, {
        decision: body.decision,
        ...(body.remember === undefined
          ? {}
          : {
              remember: {
                tool_glob: body.remember.toolGlob,
                scope: body.remember.scope,
                ...(body.remember.exact ? { exact: true } : {}),
              },
            }),
      }),
    rememberOptions: (id) => get(`/v1/approvals/${enc(id)}/remember`),
    approveAll: (runId, approvalIds) =>
      send("POST", "/v1/approvals/approve-all", {
        run_id: runId,
        approval_ids: [...approvalIds],
      }),
  };
}

/**
 * The download URL of the user's export of their threads in `teamId` (D18, KOBE-18): a zip of Pi
 * JSONL sessions and Markdown transcripts. A link can't send `X-Kobe-Team`, so the team goes in
 * the query and the server checks it against the session's active team.
 */
export function threadExportUrl(teamId: string): string {
  return `/v1/threads/export${query({ team: teamId })}`;
}

/**
 * The download URL of one conversation as Markdown (`/export`, KOBE-450): the owner's only; the
 * team goes in the query as for `threadExportUrl`.
 */
export function threadExportOneUrl(threadId: string, teamId: string): string {
  return `/v1/threads/${enc(threadId)}/export${query({ team: teamId })}`;
}

/** The SSE URL of a run's events after `seq` (KOBE-31; the session cookie authenticates it). */
export function runEventsUrl(runId: string, startingAfter: number): string {
  return `/v1/runs/${enc(runId)}/events${query({ starting_after: startingAfter })}`;
}
