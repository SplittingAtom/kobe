/**
 * Chat resources over the shared API client (`lib/api/client.ts`). Every call is team-scoped and
 * sends `X-Kobe-Team`, reads included, so a tab left on another team gets `team_mismatch` instead of
 * acting on the wrong team. Request bodies use the routes' snake_case (spec §6.1).
 */
import { apiDownload, apiRequest, apiTextFile, type ApiResult, type TextFile } from "../api/client";
import type { ArtifactDetailView, ArtifactSummaryView } from "./artifacts";
import type { BudgetStatus } from "../admin/api/budgets";
import type { RunUsage } from "../admin/api/usage";
import { listTeamModels, type TeamModels } from "../admin/api/team/models";
import { createMemoryApi } from "../memory/api";
import type {
  ApprovalDecisionBody,
  ApprovalView,
  EgressRequest,
  EntryPage,
  PendingMessages,
  RunnableAgent,
  RunSnapshot,
  SubmitResult,
  ThreadDetail,
  ThreadPage,
  ThreadRuns,
  ThreadSearchPage,
  ThreadSummary,
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

/** What the chat shows of the team's retention (`GET /v1/team/retention`, camelized). */
export interface TeamRetentionNotice {
  readonly upcoming: { readonly period: string; readonly effectiveAt: string } | null;
}

const RUNNABLE_PAGE_SIZE = 200;
/** A guard, not a limit anyone reaches: 10 pages of 200. */
const RUNNABLE_MAX_PAGES = 10;

interface RunnablePage {
  readonly agents: readonly RunnableAgent[];
  readonly nextCursor: string | null;
}

export interface ChatApi {
  listThreads(cursor?: string): Promise<ApiResult<ThreadPage>>;
  searchThreads(q: string, cursor?: string): Promise<ApiResult<ThreadSearchPage>>;
  listTrash(cursor?: string): Promise<ApiResult<ThreadPage>>;
  /** A new thread; `model` is an enabled alias, or null/absent for the team default (KOBE-44). */
  createThread(
    title?: string,
    model?: string | null,
    agent?: { readonly agentId: string; readonly test: boolean },
  ): Promise<ApiResult<ThreadSummary>>;
  /** Agents the user can start a chat with in this team, every page (KOBE-122). */
  runnableAgents(): Promise<ApiResult<readonly RunnableAgent[]>>;
  /** Clears the caller's builder test threads of one agent (KOBE-85); they go to Trash, hidden. */
  clearTestThreads(agentId: string): Promise<ApiResult<{ readonly cleared: number }>>;
  /** Sets the thread's model for its next runs (an enabled alias; null = the team default). */
  setThreadModel(threadId: string, model: string | null): Promise<ApiResult<ThreadSummary>>;
  /** The install catalog with the team's enabled models and default (`GET /v1/team/models`). */
  listModels(): Promise<ApiResult<TeamModels>>;
  /** The thread with its entries after `after` (0 = from the start). */
  getThread(threadId: string, after?: number): Promise<ApiResult<ThreadDetail>>;
  /** The thread without its entries (the thread list's `fetch`). */
  threadSummary(threadId: string): Promise<ApiResult<ThreadSummary>>;
  listEntries(threadId: string, after: number): Promise<ApiResult<EntryPage>>;
  renameThread(threadId: string, title: string | null): Promise<ApiResult<ThreadSummary>>;
  trashThread(threadId: string): Promise<ApiResult<ThreadSummary>>;
  restoreThread(threadId: string): Promise<ApiResult<ThreadSummary>>;
  /** The team's retention period and any upcoming shortening (KOBE-18 banner). */
  retention(): Promise<ApiResult<TeamRetentionNotice>>;
  /** "Delete forever" from Trash (D18, KOBE-18): the owner only; 204. */
  purgeThread(threadId: string): Promise<ApiResult<void>>;
  setLeaf(threadId: string, entryId: string): Promise<ApiResult<ThreadSummary>>;
  sendMessage(
    threadId: string,
    body: {
      readonly content: string;
      readonly parentEntryId?: string | undefined;
      readonly fileIds?: readonly string[] | undefined;
    },
    idempotencyKey: string,
  ): Promise<ApiResult<SubmitResult>>;
  listRuns(threadId: string): Promise<ApiResult<ThreadRuns>>;
  pendingMessages(threadId: string): Promise<ApiResult<PendingMessages>>;
  resumeQueue(threadId: string): Promise<ApiResult<ThreadRuns>>;
  getRun(runId: string): Promise<ApiResult<RunSnapshot>>;
  editQueued(runId: string, content: string): Promise<ApiResult<RunSnapshot>>;
  steer(runId: string, content: string): Promise<ApiResult<RunSnapshot>>;
  cancel(runId: string): Promise<ApiResult<RunSnapshot>>;
  retry(runId: string): Promise<ApiResult<SubmitResult>>;
  /** Tokens and spend of one run (KOBE-43), as the model gateway measured them. */
  runUsage(runId: string): Promise<ApiResult<RunUsage>>;
  /** The member's budgets and how much is used (KOBE-42: the 80 % warning, the 100 % stop). */
  budgetStatus(): Promise<ApiResult<BudgetStatus>>;
  /** One of your approvals with its full input (KOBE-37). */
  getApproval(approvalId: string): Promise<ApiResult<ApprovalView>>;
  /** `POST /v1/approvals/{id}` (§6.1): allow or deny, optionally remembering an allow. */
  decideApproval(approvalId: string, body: ApprovalDecisionBody): Promise<ApiResult<ApprovalView>>;
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
  /** The bytes of a file the agent shared (`GET /v1/files/:id/content`, KOBE-150). */
  downloadSharedFile(fileId: string): Promise<ApiResult<Uint8Array>>;
  /**
   * Undo of a `memory.updated` (KOBE-158): restores `version` (a new version with the old content)
   * or, for a doc the write created, deletes it (`undoMemoryAction`).
   */
  undoMemory(
    docId: string,
    action: { readonly action: "restore"; readonly version: number } | { readonly action: "delete" },
  ): Promise<ApiResult<unknown>>;
  /** Your own requests for one domain, newest first. */
  egressRequests(
    domain: string,
  ): Promise<ApiResult<{ readonly requests: readonly EgressRequest[] }>>;
}

/** The chat API for one team; `teamId` goes in `X-Kobe-Team` on every request. */
export function createChatApi(teamId: string, fetchFn?: typeof fetch): ChatApi {
  const get = <T>(path: string) => apiRequest<T>(path, { teamId, fetchFn });
  const memory = createMemoryApi(teamId, fetchFn);
  const send = <T>(method: "POST" | "PATCH" | "DELETE", path: string, json?: unknown) =>
    apiRequest<T>(path, { method, json, teamId, fetchFn });

  return {
    listThreads: (cursor) => get(`/v1/threads${query({ cursor })}`),
    searchThreads: (q, cursor) => get(`/v1/threads${query({ q, cursor })}`),
    listTrash: (cursor) => get(`/v1/threads/trash${query({ cursor })}`),
    createThread: (title, model, agent) =>
      send("POST", "/v1/threads", {
        ...(title === undefined ? {} : { title }),
        ...(model === undefined || model === null ? {} : { model }),
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
    listModels: () => listTeamModels(teamId, fetchFn),
    getThread: (id, after = 0) =>
      get(`/v1/threads/${enc(id)}${query({ after: after > 0 ? after : undefined, limit: 500 })}`),
    threadSummary: (id) => get(`/v1/threads/${enc(id)}${query({ limit: 1 })}`),
    listEntries: (id, after) =>
      get(`/v1/threads/${enc(id)}/entries${query({ after, limit: 500 })}`),
    renameThread: (id, title) => send("PATCH", `/v1/threads/${enc(id)}`, { title }),
    trashThread: (id) => send("DELETE", `/v1/threads/${enc(id)}`),
    restoreThread: (id) => send("POST", `/v1/threads/${enc(id)}/restore`),
    purgeThread: (id) => send("POST", `/v1/threads/${enc(id)}/purge`),
    retention: () => get("/v1/team/retention"),
    setLeaf: (id, entryId) => send("POST", `/v1/threads/${enc(id)}/leaf`, { entry_id: entryId }),
    sendMessage: (id, body, idempotencyKey) =>
      apiRequest(`/v1/threads/${enc(id)}/messages`, {
        method: "POST",
        json: {
          content: body.content,
          ...(body.parentEntryId === undefined ? {} : { parent_entry_id: body.parentEntryId }),
          ...(body.fileIds === undefined || body.fileIds.length === 0
            ? {}
            : { file_ids: body.fileIds }),
        },
        teamId,
        idempotencyKey,
        fetchFn,
      }),
    listRuns: (id) => get(`/v1/threads/${enc(id)}/runs`),
    pendingMessages: (id) => get(`/v1/threads/${enc(id)}/pending-messages`),
    resumeQueue: (id) => send("POST", `/v1/threads/${enc(id)}/queue/resume`),
    getRun: (runId) => get(`/v1/runs/${enc(runId)}`),
    editQueued: (runId, content) => send("PATCH", `/v1/runs/${enc(runId)}`, { content }),
    steer: (runId, content) => send("POST", `/v1/runs/${enc(runId)}/steer`, { content }),
    cancel: (runId) => send("POST", `/v1/runs/${enc(runId)}/cancel`),
    retry: (runId) => send("POST", `/v1/runs/${enc(runId)}/retry`),
    runUsage: (runId) => get(`/v1/runs/${enc(runId)}/usage`),
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
                ...(body.remember.expiresIn === undefined
                  ? {}
                  : { expires_in: body.remember.expiresIn }),
              },
            }),
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

/** The SSE URL of a run's events after `seq` (KOBE-31; the session cookie authenticates it). */
export function runEventsUrl(runId: string, startingAfter: number): string {
  return `/v1/runs/${enc(runId)}/events${query({ starting_after: startingAfter })}`;
}
