/**
 * The chat for one team in one tab: the API bound to the team, and the open threads' controllers.
 * A controller lives while a view holds it (`acquire` / `release`); a thread created by the thread
 * list (`seed`) is ready before its view mounts, so the first message goes to the same controller.
 */
import { AppContextStore, ComposerInsertChannel } from "../apps/app-context";
import { AppItemStore } from "../apps/app-items";
import { SkillPickStore } from "./skill-picks";
import { ViewingStore } from "./viewing";
import { AutoOpenEditsStore, EditDraftStore, FileReviewStore } from "../files/editor-state";
import { NotebookExecStore } from "../notebooks/executions";
import { createNotebookApi, type NotebookApi } from "../notebooks/api";
import { DraftConnectorStore } from "./draft-connectors";
import { AppCardSignal } from "../apps/app-cards";
import type { ThinkingLevel } from "@kobe/protocol";
import type { ApiResult } from "../api/client";
import type { TeamModels } from "../admin/api/team/models";
import type { ChatApi } from "./api";
import { createFilesApi, type FilesApi } from "../files/api";
import { WorkspaceChangeFeed } from "../files/remote-changes";
import { createProjectsApi, type Project } from "../projects/api";
import { AttachmentStore } from "./attachments";
import { ComposerMentionChannel } from "./mention-insert";
import { MentionStore } from "./mentions";
import { SentFileCache } from "./sent-files";
import { xhrUploadTransport, type UploadTransport } from "./uploads";
import type { EventSourceFactory } from "./stream";
import { ThreadController } from "./thread-controller";
import { activityOfState, ThreadActivityStore } from "./thread-activity";
import { organizeRequest, type OrganizeChange } from "./organize";
import type { ThreadListSync } from "./thread-list-sync";
import type { RunnableAgent, ThreadSummary, ThreadVisibility } from "./types";

export interface ChatSessionOptions {
  readonly teamId: string;
  readonly api: ChatApi;
  readonly eventSource?: EventSourceFactory | undefined;
  readonly newKey?: (() => string) | undefined;
  readonly reopenDelayMs?: ((attempt: number) => number) | undefined;
  /** Builder test pane (KOBE-85): new threads are test threads on this agent's draft. */
  readonly testAgentId?: string | undefined;
  /** Workbench test pane (KOBE-323): new threads are test chats of this skill draft. */
  readonly testSkillDraftId?: string | undefined;
  /** Tests replace the files API behind the chips of sent messages (KOBE-194). */
  readonly fetchFn?: typeof fetch | undefined;
  /** Tests replace the XHR upload transport (KOBE-145). */
  readonly uploadTransport?: UploadTransport | undefined;
  /** This browser's other tabs (CE19 pin, archive, move); the session closes it on dispose. */
  readonly listSync?: ThreadListSync | undefined;
}

interface Held {
  readonly controller: ThreadController;
  count: number;
}

const TITLE_MAX = 80;
/** How long the team's model list is reused by the chat's model picker. */
export const MODELS_TTL_MS = 30_000;
/** A fresh read this recent answers another fresh request. */
const MODELS_FRESH_SHARE_MS = 1_000;

/**
 * A new thread's name in the rail until the server titles it (KOBE-219): the first line of its
 * first message, shortened. Never sent: a thread created with a title would not be auto-titled.
 */
export function titleFrom(text: string): string | undefined {
  const line =
    text
      .trim()
      .split(/\r?\n/u, 1)[0]
      ?.replace(/\p{Cc}/gu, "")
      .trim() ?? "";
  if (line === "") return undefined;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

/** The new-conversation choices a rail launch from that view carries (KOBE-458). */
export interface AppLaunchDraft {
  /** Absent: the server's default agent; null: No agent. */
  readonly agentId?: string | null;
  readonly connectorsOff: readonly string[];
}

/** How long the agent list is reused by the picker and the header. */
export const AGENTS_TTL_MS = 30_000;

export class ChatSession {
  readonly teamId: string;
  readonly api: ChatApi;
  /** Files attached to the composer drafts of this tab (KOBE-145). */
  readonly attachments: AttachmentStore;
  /** The caller's workspace files: the composer's `@` picker (KOBE-223) and sent chips. */
  readonly files: FilesApi;
  /** The conversation's kernel: run, interrupt, restart (KOBE-465). */
  readonly notebooks: NotebookApi;
  /** Files picked with `@` per composer draft (KOBE-223). */
  readonly mentions = new MentionStore();
  /** Mentions asked from the Files rail (drag, row menu) for the composer on screen (KOBE-374). */
  readonly composerMentions = new ComposerMentionChannel();
  /** MCP Apps context chips per composer draft (KOBE-439). */
  readonly appContexts = new AppContextStore();
  /** The skill picked from the composer's + menu per draft (KOBE-451). */
  readonly skillPicks = new SkillPickStore();
  /** The workspace file open in the artifact column, sent as `viewing` (KOBE-463). */
  readonly viewing = new ViewingStore();
  /** The file editor's unsaved drafts per file (KOBE-463). */
  readonly editDrafts = new EditDraftStore();
  /** Live changes to the files open in this page's tabs (KOBE-496): one stream per page. */
  readonly fileChanges: WorkspaceChangeFeed;
  /** The agent's file edit proposals under review per file (KOBE-463). */
  readonly fileReviews = new FileReviewStore();
  /** The proposal cards' auto-open switch (KOBE-489), seeded from the stored preference. */
  readonly autoOpenEdits = new AutoOpenEditsStore();
  /** Kernel executions seen in this tab's run streams (KOBE-465: the notebook panel). */
  readonly notebookRuns = new NotebookExecStore();
  /** Connectors turned off before the first message (KOBE-451 review MEDIUM-3). */
  readonly draftConnectors = new DraftConnectorStore();
  /** MCP Apps `ui/message` items as chips per composer draft (KOBE-490); never sent by themselves. */
  readonly appItems = new AppItemStore();
  /** MCP Apps `ui/message` text for the composer on screen (KOBE-439); never sent by itself. */
  readonly composerInserts = new ComposerInsertChannel();
  /** A rail launch changed a thread's app cards (KOBE-440): the thread reads them again. */
  readonly appCards = new AppCardSignal();
  /** Size and thumbnail lookups for the chips of sent messages after a reload (KOBE-194). */
  readonly sentFiles: SentFileCache;
  /** Set for the builder's test pane: threads it creates run this agent's unpublished draft. */
  get testAgentId(): string | undefined {
    return this.#options.testAgentId;
  }
  /** Set for the Workbench test pane: threads it creates run only this skill draft. */
  get testSkillDraftId(): string | undefined {
    return this.#options.testSkillDraftId;
  }
  /** The agent picker is for the chat; the test panes are fixed on their agent. */
  get canChooseAgent(): boolean {
    return this.#options.testAgentId === undefined && this.#options.testSkillDraftId === undefined;
  }
  /** What the threads held open here are doing, live (KOBE-301: the rail's dots, the tab title). */
  readonly activity = new ThreadActivityStore();
  readonly #options: ChatSessionOptions;
  readonly #held = new Map<string, Held>();
  /** Stops following a held controller's activity. */
  readonly #untrack = new Map<string, () => void>();
  /** Title for the thread `initialize` creates next (taken from the message being sent). */
  #nextTitle: string | undefined;
  readonly #composerDrafts = new Map<string, string>();
  readonly #createdListeners = new Set<() => void>();
  readonly #retitledListeners = new Set<(threadId: string, title: string) => void>();
  readonly #listChangedListeners = new Set<() => void>();
  readonly #trashListeners = new Set<() => void>();
  /** First lines of threads created here, shown until their title arrives (KOBE-219). */
  readonly #provisional = new Map<string, string>();
  /** Model for the thread `initialize` creates next (the new-thread picker; null = default). */
  #nextModel: string | null = null;
  #nextThinking: ThinkingLevel | null = null;
  /** Project for the thread `initialize` creates next (`/?project=<id>`, KOBE-164). */
  #nextProjectId: string | null = null;
  /** Agent for the thread `initialize` creates next (null = plain chat; KOBE-122). */
  #nextAgent: RunnableAgent | null = null;
  /** The runnable gallery agent Kobe (null when missing, suspended or archived), preselected untouched. */
  #defaultAgent: RunnableAgent | null = null;
  /** The user picked (or cleared) the agent for this draft: the default no longer applies. */
  #agentTouched = false;
  readonly #agentListeners = new Set<() => void>();
  #agents:
    | { readonly at: number; readonly result: Promise<ApiResult<readonly RunnableAgent[]>> }
    | undefined;
  #projects:
    { readonly at: number; readonly result: Promise<ApiResult<readonly Project[]>> } | undefined;
  #models:
    | {
        readonly at: number;
        readonly fresh: boolean;
        readonly result: Promise<ApiResult<TeamModels>>;
      }
    | undefined;

  constructor(options: ChatSessionOptions) {
    this.teamId = options.teamId;
    this.api = options.api;
    this.attachments = new AttachmentStore({
      teamId: options.teamId,
      transport: options.uploadTransport ?? xhrUploadTransport,
    });
    this.files = createFilesApi(options.teamId, options.fetchFn);
    this.notebooks = createNotebookApi(options.teamId, options.fetchFn);
    this.sentFiles = new SentFileCache(this.files);
    this.fileChanges = new WorkspaceChangeFeed({
      teamId: options.teamId,
      eventSource: options.eventSource,
      // Another tab switched the active team: this page's stream can never open again.
      probe: async () => {
        const res = await this.files.list("");
        return res.ok || res.error.code !== "team_mismatch";
      },
    });
    this.#options = options;
    options.listSync?.subscribe((threadId) => this.#listChanged(threadId));
  }

  #create(threadId: string | null): ThreadController {
    return new ThreadController(threadId, {
      api: this.api,
      eventSource: this.#options.eventSource,
      ...(this.#options.newKey ? { newKey: this.#options.newKey } : {}),
      ...(this.#options.reopenDelayMs ? { reopenDelayMs: this.#options.reopenDelayMs } : {}),
      onRetitled: (id, title) => {
        for (const listener of this.#retitledListeners) listener(id, title);
      },
      onRunEvents: (id, events) => this.notebookRuns.apply(id, events),
    });
  }

  /** Follows a held thread's activity until it is let go. */
  #track(threadId: string, controller: ThreadController): ThreadController {
    const update = () => this.activity.set(threadId, activityOfState(controller.getState()));
    update();
    this.#untrack.set(threadId, controller.subscribe(update));
    return controller;
  }

  #untrackThread(threadId: string): void {
    this.#untrack.get(threadId)?.();
    this.#untrack.delete(threadId);
    this.activity.release(threadId);
  }

  /** The controller for a thread (a fresh draft for `null`); call `release` when done. */
  acquire(threadId: string | null): ThreadController {
    if (threadId === null) return this.#create(null);
    const held = this.#held.get(threadId);
    if (held) {
      held.count += 1;
      return held.controller;
    }
    const controller = this.#create(threadId);
    this.#held.set(threadId, { controller, count: 1 });
    this.#track(threadId, controller);
    void controller.load();
    return controller;
  }

  release(threadId: string | null, controller: ThreadController): void {
    if (threadId === null) {
      controller.dispose();
      return;
    }
    const held = this.#held.get(threadId);
    if (!held || held.controller !== controller) return;
    held.count -= 1;
    if (held.count > 0) return;
    this.#held.delete(threadId);
    this.#untrackThread(threadId);
    controller.dispose();
  }

  /** A thread just created by the thread list: ready (empty) and not read again on mount. */
  seed(summary: ThreadSummary): ThreadController {
    const existing = this.#held.get(summary.threadId);
    if (existing) return existing.controller;
    const controller = this.#create(summary.threadId);
    controller.seed(summary);
    this.#held.set(summary.threadId, { controller, count: 0 });
    return this.#track(summary.threadId, controller);
  }

  peek(threadId: string): ThreadController | undefined {
    return this.#held.get(threadId)?.controller;
  }

  /**
   * Text to put in a thread's composer when it opens, once (a fork at a prompt, KOBE-216): a
   * draft to edit or send, never sent by itself.
   */
  setComposerDraft(threadId: string, text: string): void {
    this.#composerDrafts.set(threadId, text);
  }

  takeComposerDraft(threadId: string): string | undefined {
    const text = this.#composerDrafts.get(threadId);
    this.#composerDrafts.delete(threadId);
    return text;
  }

  setNextTitle(text: string): void {
    this.#nextTitle = titleFrom(text);
  }

  /** The rail's name for a thread created here before its title arrives (KOBE-219). */
  provisionalTitle(threadId: string): string | undefined {
    return this.#provisional.get(threadId);
  }

  setProvisionalTitle(threadId: string, title: string | undefined): void {
    if (title === undefined) this.#provisional.delete(threadId);
    else this.#provisional.set(threadId, title);
  }

  takeNextTitle(): string | undefined {
    const title = this.#nextTitle;
    this.#nextTitle = undefined;
    return title;
  }

  /** The project the conversation not created yet will belong to, or null. */
  get draftProjectId(): string | null {
    return this.#nextProjectId;
  }

  setDraftProject(projectId: string | null): void {
    this.#nextProjectId = projectId;
  }

  /** The draft's project for the thread being created; the next draft starts without one. */
  takeNextProject(): string | null {
    const id = this.#nextProjectId;
    this.#nextProjectId = null;
    return id;
  }

  /** The model picked for a conversation not created yet (KOBE-44). */
  get draftModel(): string | null {
    return this.#nextModel;
  }

  setDraftModel(model: string | null): void {
    this.#nextModel = model;
  }

  /** The thinking level picked for a conversation not created yet (KOBE-260). */
  get draftThinking(): ThinkingLevel | null {
    return this.#nextThinking;
  }

  setDraftThinking(level: ThinkingLevel | null): void {
    this.#nextThinking = level;
  }

  /** The draft's thinking level for the thread being created; the next draft starts without. */
  takeNextThinking(): ThinkingLevel | null {
    const level = this.#nextThinking;
    this.#nextThinking = null;
    return level;
  }

  /** The agent picked for a conversation not created yet (KOBE-122); null = plain chat. */
  get draftAgent(): RunnableAgent | null {
    return this.#nextAgent;
  }

  setDraftAgent(agent: RunnableAgent | null): void {
    this.#agentTouched = true;
    this.#setAgent(agent);
  }

  #setAgent(agent: RunnableAgent | null): void {
    this.#nextAgent = agent;
    for (const listener of this.#agentListeners) listener();
  }

  /** `useSyncExternalStore` subscription to `draftAgent`. */
  subscribeDraftAgent = (listener: () => void): (() => void) => {
    this.#agentListeners.add(listener);
    return () => this.#agentListeners.delete(listener);
  };

  /** The draft's agent for the thread being created; the next draft starts as a plain chat. */
  takeNextAgent(): RunnableAgent | null {
    const agent = this.#nextAgent;
    this.#agentTouched = false;
    this.#setAgent(this.#defaultAgent);
    return agent;
  }

  /**
   * What a rail launch from the new-conversation view carries (KOBE-458 review MEDIUM-1): the
   * agent picked there (null: No agent) once the member touched the picker, else nothing, so the
   * server applies the same default; and the connectors turned off there.
   */
  launchDraft(): AppLaunchDraft {
    return {
      ...(this.canChooseAgent && this.#agentTouched
        ? { agentId: this.#nextAgent?.id ?? null }
        : {}),
      connectorsOff: [...this.draftConnectors.snapshot()],
    };
  }

  /** That launch created the thread: the next new conversation starts afresh, as after a send. */
  launchDraftTaken(): void {
    this.takeNextAgent();
    this.draftConnectors.take();
  }

  /**
   * New chats start with the agent the server marks `default` (gallery Kobe when it is runnable
   * here; KOBE-458: the same rule a rail launch's new thread follows), else No agent.
   */
  #applyDefaultAgent(agents: readonly RunnableAgent[]): void {
    this.#defaultAgent = agents.find((a) => a.default === true) ?? null;
    if (!this.#agentTouched) this.#setAgent(this.#defaultAgent);
  }

  /** Agents the user can run in this team, reused for `AGENTS_TTL_MS`. */
  agents(): Promise<ApiResult<readonly RunnableAgent[]>> {
    const now = Date.now();
    if (this.#agents && now - this.#agents.at < AGENTS_TTL_MS) return this.#agents.result;
    const result = this.api.runnableAgents().then((res) => {
      if (res.ok) this.#applyDefaultAgent(res.data);
      return res;
    });
    this.#agents = { at: now, result };
    return result;
  }

  /** The draft's model for the thread being created; the next draft starts from the default. */
  takeNextModel(): string | null {
    const model = this.#nextModel;
    this.#nextModel = null;
    return model;
  }

  /**
   * The team's models for the picker, read at most every `MODELS_TTL_MS` (a team admin's change
   * shows on the next thread opened after that, or at once after a failed run asks again).
   */
  models(options: { readonly fresh?: boolean } = {}): Promise<ApiResult<TeamModels>> {
    const now = Date.now();
    const cached = this.#models;
    if (!options.fresh && cached && now - cached.at < MODELS_TTL_MS) return cached.result;
    // Several readers asking fresh at once (the picker and the context gauge) share one read.
    if (options.fresh && cached?.fresh && now - cached.at < MODELS_FRESH_SHARE_MS) {
      return cached.result;
    }
    const result = this.api.listModels();
    this.#models = { at: now, fresh: options.fresh === true, result };
    return result;
  }

  /**
   * The projects the member may start threads in, so may move a thread to (CE19: the live ones
   * they can open), read at most every `MODELS_TTL_MS`. The server decides each move again.
   */
  projects(): Promise<ApiResult<readonly Project[]>> {
    const now = Date.now();
    const cached = this.#projects;
    if (cached && now - cached.at < MODELS_TTL_MS) return cached.result;
    const result = createProjectsApi(this.teamId, this.#options.fetchFn).list(false);
    this.#projects = { at: now, result };
    // A failed read is not kept: the next menu asks again.
    void result.then((res) => {
      if (!res.ok && this.#projects?.result === result) this.#projects = undefined;
    });
    return result;
  }

  /** Called when a new thread got its first message (the thread list reads its title again). */
  onThreadCreated(listener: () => void): () => void {
    this.#createdListeners.add(listener);
    return () => this.#createdListeners.delete(listener);
  }

  threadCreated(): void {
    for (const listener of this.#createdListeners) listener();
  }

  /** The server titled a thread (KOBE-219 `thread.updated`); the rail reads its list again. */
  onThreadRetitled(listener: (threadId: string, title: string) => void): () => void {
    this.#retitledListeners.add(listener);
    return () => this.#retitledListeners.delete(listener);
  }

  /**
   * A thread went to Trash, came back or was deleted forever from the list (KOBE-535): the
   * lineage strip reads its family again (TL4).
   */
  onThreadTrashChanged(listener: () => void): () => void {
    this.#trashListeners.add(listener);
    return () => this.#trashListeners.delete(listener);
  }

  threadTrashChanged(): void {
    for (const listener of this.#trashListeners) listener();
  }

  /** A thread was pinned, archived or moved, here or in another tab: the rail reads its list. */
  onThreadListChanged(listener: () => void): () => void {
    this.#listChangedListeners.add(listener);
    return () => this.#listChangedListeners.delete(listener);
  }

  #listChanged(threadId: string): void {
    for (const listener of this.#listChangedListeners) listener();
    // The open conversation follows too (its project bar, its archived note).
    void this.peek(threadId)?.refresh();
  }

  /**
   * Pins, archives or moves one of the member's threads (CE19, KOBE-220). Once the server saved
   * it, this tab's rail and the thread read again, and the other tabs are told.
   */
  async organize(threadId: string, change: OrganizeChange): Promise<ApiResult<ThreadSummary>> {
    const res = await organizeRequest(this.api, threadId, change);
    if (res.ok) {
      this.#listChanged(threadId);
      this.#options.listSync?.post(threadId);
    }
    return res;
  }

  /**
   * Sets who reads one of the member's threads (CE20, KOBE-221): only them, the project's members
   * or the whole team; `private` revokes. Once saved, the rail and the thread read again.
   */
  async share(threadId: string, visibility: ThreadVisibility): Promise<ApiResult<ThreadSummary>> {
    const res = await this.api.shareThread(threadId, visibility);
    if (res.ok) {
      this.#listChanged(threadId);
      this.#options.listSync?.post(threadId);
    }
    return res;
  }

  dispose(): void {
    this.#options.listSync?.close();
    this.attachments.dispose();
    this.sentFiles.dispose();
    this.fileChanges.dispose();
    for (const untrack of this.#untrack.values()) untrack();
    this.#untrack.clear();
    this.activity.clear();
    for (const held of this.#held.values()) held.controller.dispose();
    this.#held.clear();
  }
}
