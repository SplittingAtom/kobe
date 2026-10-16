/**
 * One open thread: loads it from Postgres through the API (never wakes a sandbox, D14), streams
 * the run that holds it (or the next queued one) and turns user actions into API calls (D17:
 * queue, Steer, Stop; D14: Retry / Continue without retry; branch switch and edit-and-regenerate).
 * The server decides everything; this only shows what it says and asks again after each change.
 */
import { isTerminalRunStatus, type KobeEvent } from "@kobe/protocol";
import type { ApiError, ApiResult } from "../api/client";
import type { ChatApi, CompactResult, ForkOptions } from "./api";
import { newIdempotencyKey } from "./keys";
import {
  browserResumeStore,
  clearResumePoint,
  loadResumePoint,
  saveResumePoint,
  type ResumeStore,
} from "./resume";
import { applyRunEvents, newLiveRun, type CommittedEntry } from "./live";
import {
  openRunStream,
  type EventSourceFactory,
  type RunStream,
  type StreamSignal,
} from "./stream";
import {
  canRegenerateWith,
  currentRunId,
  initialThreadState,
  isThreadRunning,
  mergeCommittedEntries,
  mergeServerEntries,
  promptSaved,
  queuedRuns,
  runToStream,
  settleStop,
  type ThreadState,
} from "./thread-state";
import type { MessageFiles } from "./attachments";
import { SHARED_ANNOUNCEMENT } from "./share";
import type { ThreadEntry, ThreadRuns, ThreadSummary, ThreadVisibility } from "./types";

const NO_THREAD: ApiError = {
  status: 0,
  code: "thread_not_found",
  message: "Send a message first: there is no conversation to compact.",
};

export interface ControllerOptions {
  readonly api: ChatApi;
  readonly eventSource?: EventSourceFactory | undefined;
  /** Idempotency keys for sends (tests pass a counter). */
  readonly newKey?: () => string;
  /** Delay before reopening a stream the server closed while its run was still active. */
  readonly reopenDelayMs?: (attempt: number) => number;
  /** Per-tab resume points (`resume.ts`); default sessionStorage, `null` to always replay. */
  readonly resumeStore?: ResumeStore | null | undefined;
  /** The server titled the thread after a run (KOBE-219 `thread.updated`): the rail reads it. */
  readonly onRetitled?: ((threadId: string, title: string) => void) | undefined;
}

const MAX_REOPEN_ATTEMPTS = 5;
const MAX_ENTRY_PAGES = 40;
const REGENERATE_NOT_SENT: ApiError = {
  status: 0,
  code: "regenerate_not_sent",
  message: "The answer could not be regenerated, so the model was not changed. Try again.",
};

const CLIENT_ERROR: ApiError = {
  status: 0,
  code: "client_error",
  message: "Your message was not sent. Try again.",
};
const PARTIAL_HISTORY = "Part of this conversation could not be loaded. Reload to see all of it.";

type Listener = () => void;

export class ThreadController {
  #state: ThreadState;
  readonly #listeners = new Set<Listener>();
  readonly #api: ChatApi;
  readonly #eventSource: EventSourceFactory | undefined;
  readonly #newKey: () => string;
  readonly #reopenDelay: (attempt: number) => number;
  readonly #resume: ResumeStore | undefined;
  #stream: RunStream | undefined;
  /** A completed run's stream kept open for its announced epilogue (KOBE-234/219). */
  #epilogue: RunStream | undefined;
  readonly #onRetitled: ((threadId: string, title: string) => void) | undefined;
  #reopenAttempts = 0;
  #reopenTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshAgain = false;
  #disposed = false;
  #loadStarted = false;
  #leafVersion = 0;
  #lastStreamedRun: string | undefined;

  constructor(threadId: string | null, options: ControllerOptions) {
    this.#state = initialThreadState(threadId);
    this.#api = options.api;
    this.#eventSource = options.eventSource;
    this.#newKey = options.newKey ?? newIdempotencyKey;
    this.#reopenDelay = options.reopenDelayMs ?? ((n) => Math.min(1000 * 2 ** n, 15_000));
    this.#resume =
      options.resumeStore === null ? undefined : (options.resumeStore ?? browserResumeStore());
    this.#onRetitled = options.onRetitled;
  }

  // --- store ----------------------------------------------------------------------------------

  readonly subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getState = (): ThreadState => this.#state;

  /** A run's token usage and spend (KOBE-43; run details). */
  readonly runUsage = (runId: string) => this.#api.runUsage(runId);

  /** Usage of each of this thread's runs (KOBE-208: the answers' footers); null for a draft. */
  readonly threadUsage = () => {
    const id = this.#state.threadId;
    return id === null ? null : this.#api.threadUsage(id);
  };

  /** How this thread's runs ended and its approvals were decided (KOBE-209); null for a draft. */
  readonly threadMarkers = () => {
    const id = this.#state.threadId;
    return id === null ? null : this.#api.threadMarkers(id);
  };

  /** A tool output of this thread in full (KOBE-208: a large one, when its card opens). */
  readonly toolOutput = (entryId: string) => {
    const id = this.#state.threadId;
    return id === null ? null : this.#api.toolOutput(id, entryId);
  };

  /** The member's budget status (KOBE-42; the chat's warning banner). */
  readonly budgetStatus = () => this.#api.budgetStatus();

  #set(change: (state: ThreadState) => ThreadState): void {
    if (this.#disposed) return;
    const next = settleStop(change(this.#state));
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #announce(announcement: string): void {
    this.#set((s) => ({ ...s, announcement, announcementSeq: s.announcementSeq + 1 }));
  }

  #fail(error: ApiError, draft?: string): void {
    this.#set((s) => ({ ...s, actionError: { error, draft } }));
  }

  readonly clearError = (): void => {
    this.#set((s) => (s.actionError ? { ...s, actionError: undefined } : s));
  };

  async #busy<T>(action: string, fn: () => Promise<T>): Promise<T> {
    this.#set((s) => ({ ...s, busy: [...s.busy, action], actionError: undefined }));
    try {
      return await fn();
    } finally {
      this.#set((s) => ({ ...s, busy: s.busy.filter((a) => a !== action) }));
    }
  }

  // --- lifecycle --------------------------------------------------------------------------------

  /** A thread created a moment ago (empty, idle): nothing to read. */
  seed(summary: ThreadSummary): void {
    this.#loadStarted = true;
    this.#set((s) => ({ ...s, phase: "ready", summary }));
  }

  /** Shows an error raised outside this controller (e.g. creating the thread failed). */
  readonly reportError = (error: ApiError, draft?: string): void => {
    this.#fail(error, draft);
  };

  /** Reads the thread, its runs and pending messages, then streams the run that holds it. */
  async load(): Promise<void> {
    const threadId = this.#state.threadId;
    if (threadId === null || this.#loadStarted) return;
    this.#loadStarted = true;
    const detail = await this.#api.getThread(threadId);
    if (this.#disposed) return;
    if (!detail.ok) {
      this.#loadStarted = false; // "Try again" may load again
      this.#set((s) => ({ ...s, phase: "error", loadError: detail.error }));
      return;
    }
    const {
      entries: firstPage,
      nextEntriesAfter,
      agentCurrentVersion: _v,
      agentModel,
      ...summary
    } = detail.data;
    const entries = await this.#readMoreEntries(threadId, firstPage, nextEntriesAfter);
    if (this.#disposed) return;
    this.#set((s) => ({
      ...s,
      phase: "ready",
      loadError: undefined,
      summary,
      agentModel: agentModel ?? null,
      entries: mergeServerEntries(s.entries, entries),
      serverSeq: maxSeq(entries, s.serverSeq),
    }));
    if (await this.#readRuns(threadId)) this.#syncStream();
  }

  /** "Try again" after the thread could not be read. */
  readonly retryLoad = (): void => {
    if (this.#loadStarted || this.#disposed) return;
    this.#set((s) => ({ ...s, phase: "loading", loadError: undefined }));
    void this.load();
  };

  async #readMoreEntries(
    threadId: string,
    first: readonly ThreadEntry[],
    nextAfter: number | null,
  ): Promise<readonly ThreadEntry[]> {
    const all = [...first];
    let after = nextAfter;
    for (let page = 0; after !== null && page < MAX_ENTRY_PAGES; page++) {
      const res = await this.#api.listEntries(threadId, after);
      if (this.#disposed) break;
      if (!res.ok) {
        // What we have is still a valid prefix of the tree; say that the rest is missing.
        this.#fail({ ...res.error, message: PARTIAL_HISTORY });
        break;
      }
      all.push(...res.data.entries);
      after = res.data.nextEntriesAfter;
    }
    return all;
  }

  /** Reads runs and pending messages; false (and an error shown) when the runs are unknown. */
  async #readRuns(threadId: string): Promise<boolean> {
    const [runs, pending] = await Promise.all([
      this.#api.listRuns(threadId),
      this.#api.pendingMessages(threadId),
    ]);
    if (this.#disposed) return false;
    if (runs.ok) this.#applyRuns(runs.data);
    else this.#fail(runs.error);
    if (!pending.ok) this.#fail(pending.error);
    else {
      const messages = pending.data.messages;
      this.#set((s) => {
        const live = s.live;
        const prompt = live ? messages.find((m) => m.runId === live.runId) : undefined;
        return {
          ...s,
          pending: messages,
          livePrompt:
            prompt !== undefined
              ? {
                  text: prompt.content,
                  parentEntryId: prompt.parentEntryId,
                  files: s.livePrompt?.files,
                }
              : s.livePrompt,
        };
      });
    }
    return runs.ok;
  }

  #applyRuns(data: ThreadRuns): void {
    this.#set((s) => {
      const active = data.runs.some(
        (r) => r.status === "running" || r.status === "waiting_approval",
      );
      const queued = data.runs.some((r) => r.status === "queued");
      // The server's flag when it sends one; otherwise ours holds until a run starts or the queue empties.
      const queuePaused = data.queuePaused ?? (s.queuePaused && !active && queued);
      return { ...s, runs: data.runs, interruptedRun: data.interruptedRun, queuePaused };
    });
  }

  /** New entries, the summary (leaf, status), runs and pending messages; then the right stream. */
  readonly refresh = async (): Promise<void> => {
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return this.#refreshing;
    }
    this.#refreshing = (async () => {
      try {
        do {
          this.#refreshAgain = false;
          await this.#refreshOnce();
        } while (this.#refreshAgain && !this.#disposed);
      } finally {
        // Cleared in the same tick the loop ends, so no later call can be lost.
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  };

  async #refreshOnce(): Promise<void> {
    const threadId = this.#state.threadId;
    if (threadId === null || this.#disposed) return;
    const after = this.#state.serverSeq;
    const leafVersion = this.#leafVersion;
    const detail = await this.#api.getThread(threadId, after);
    if (this.#disposed) return;
    if (!detail.ok) {
      this.#fail(detail.error);
      return;
    }
    const {
      entries: firstPage,
      nextEntriesAfter,
      agentCurrentVersion: _v,
      agentModel,
      ...summary
    } = detail.data;
    const incoming = await this.#readMoreEntries(threadId, firstPage, nextEntriesAfter);
    if (this.#disposed) return;
    this.#set((s) => ({
      ...s,
      agentModel: agentModel ?? null,
      // A branch chosen while this read was on its way wins over the leaf it read.
      summary:
        leafVersion === this.#leafVersion || !s.summary
          ? summary
          : { ...summary, leafEntryId: s.summary.leafEntryId },
      entries: mergeServerEntries(s.entries, incoming),
      serverSeq: maxSeq(incoming, s.serverSeq),
    }));
    if (await this.#readRuns(threadId)) this.#syncStream();
  }

  /** Stops streaming (the thread is no longer on screen). */
  dispose(): void {
    this.#closeStream();
    this.#epilogue?.close();
    this.#epilogue = undefined;
    this.#disposed = true;
    this.#listeners.clear();
  }

  // --- streaming --------------------------------------------------------------------------------

  #closeStream(): void {
    if (this.#reopenTimer !== undefined) clearTimeout(this.#reopenTimer);
    this.#reopenTimer = undefined;
    this.#stream?.close();
    this.#stream = undefined;
  }

  /** Streams the run that holds the thread, or the next queued run (to see it start). */
  #syncStream(): void {
    if (this.#disposed) return;
    const runId = runToStream(this.#state);
    if (runId === undefined) {
      this.#closeStream();
      this.#set((s) => (s.connection === "idle" ? s : { ...s, connection: "idle" }));
      return;
    }
    if (this.#stream?.runId === runId) return;
    this.#closeStream();
    // A run the server keeps refusing (reopened from here) keeps its backoff.
    if (this.#lastStreamedRun !== runId) this.#reopenAttempts = 0;
    this.#lastStreamedRun = runId;
    this.#set((s) => {
      if (s.live?.runId === runId) return s;
      const prompt = s.pending.find((m) => m.runId === runId);
      return {
        ...s,
        // After a reload, resume after what the entries already hold (else replay from 0).
        live:
          loadResumePoint(this.#resume, runId, new Set(s.entries.map((e) => e.entryId))) ??
          newLiveRun(runId),
        livePrompt: prompt
          ? { text: prompt.content, parentEntryId: prompt.parentEntryId }
          : undefined,
      };
    });
    this.#open(runId);
  }

  #open(runId: string): void {
    if (this.#disposed) return;
    const after = this.#state.live?.runId === runId ? this.#state.live.lastSeq : 0;
    this.#set((s) => ({ ...s, connection: "connecting" }));
    this.#stream = openRunStream(
      runId,
      after,
      {
        onEvents: (events) => this.#onEvents(runId, events),
        onSignal: (signal) => this.#onSignal(runId, signal),
      },
      this.#eventSource,
    );
  }

  #onEvents(runId: string, events: readonly KobeEvent[]): void {
    for (const event of events) {
      if (event.type === "thread.updated") this.#retitled(event.payload);
      if (event.type === "thread.suggestions") this.#suggested(runId, event.payload);
    }
    const live = this.#state.live;
    if (!live || live.runId !== runId) return;
    const wasStarted = live.started;
    const applied = applyRunEvents(live, events);
    const now = new Date().toISOString();
    this.#set((s) => ({
      ...s,
      live: applied.run,
      entries: mergeCommittedEntries(s.entries, applied.entries, now),
      connection: "open",
    }));
    const terminal = applied.run.terminal;
    if (terminal !== undefined) clearResumePoint(this.#resume, runId);
    else if (applied.entries.length > 0) saveResumePoint(this.#resume, applied.run);
    if (terminal !== undefined && live.terminal === undefined) {
      this.#onTerminal(terminal);
      return;
    }
    if (applied.run.started && !wasStarted) {
      // A queued run started: it leaves the queue and its prompt shows in the conversation.
      this.#set((s) => (s.followups ? { ...s, followups: undefined } : s));
      this.#announce("The agent is working on your message.");
      void this.refresh();
    } else if (this.#mayBeUnsavedPrompt(applied.entries)) {
      // A prompt over 64 KiB is streamed without its body (KOBE-288): read it, so the stored
      // entry replaces the copy shown from the send.
      void this.refresh();
    }
  }

  /**
   * A body-less message entry that may be the run's prompt: no stream message bound to it (an
   * answer has one) while the prompt is not known to be saved. Large answers and tool outputs
   * once the prompt is saved are left to the reads that follow the run.
   */
  #mayBeUnsavedPrompt(entries: readonly CommittedEntry[]): boolean {
    const s = this.#state;
    if (s.live === undefined || s.livePrompt === undefined || promptSaved(s.live, s.entries)) {
      return false;
    }
    return entries.some(
      (e) => e.payload === undefined && e.type === "message" && e.messageId === undefined,
    );
  }

  /** The server's title for this thread (KOBE-219): the bar shows it at once, the rail reads it. */
  #retitled(payload: { readonly thread_id: string; readonly title: string }): void {
    if (payload.thread_id !== this.#state.threadId) return;
    this.#set((s) =>
      s.summary && s.summary.threadId === payload.thread_id
        ? { ...s, summary: { ...s.summary, title: payload.title } }
        : s,
    );
    this.#onRetitled?.(payload.thread_id, payload.title);
  }

  /**
   * The server's follow-ups after `runId` (KOBE-222): shown only while that run is still the
   * thread's latest and nothing was sent since (a late epilogue never brings old chips back).
   */
  #suggested(
    runId: string,
    payload: { readonly thread_id: string; readonly suggestions: readonly string[] },
  ): void {
    const s = this.#state;
    const current =
      payload.thread_id === s.threadId &&
      s.live?.runId === runId &&
      s.sending === undefined &&
      !isThreadRunning(s);
    if (!current) return;
    this.#set((st) => ({ ...st, followups: { runId, suggestions: payload.suggestions } }));
    // Chips appear after the answer: screen readers hear about them (review N4).
    if (s.summary?.readOnly !== true) this.#announce("Follow-up suggestions are available.");
  }

  #onTerminal(terminal: NonNullable<ThreadState["live"]>["terminal"]): void {
    if (!terminal) return;
    const messages: Record<typeof terminal.type, string> = {
      "run.completed": "The agent finished.",
      "run.failed": "The run failed.",
      "run.interrupted": "The run was stopped.",
      "run.budget_stopped": "The run stopped: the budget is used up.",
    };
    let message = messages[terminal.type];
    if (terminal.type === "run.interrupted" && terminal.payload.reason === "sandbox_lost") {
      message = "The run was interrupted. You can retry it.";
    }
    this.#set((s) => ({
      ...s,
      announcement: message,
      announcementSeq: s.announcementSeq + 1,
      summary:
        terminal.type === "run.completed" && s.summary
          ? { ...s.summary, leafEntryId: terminal.payload.leaf_entry_id ?? s.summary.leafEntryId }
          : s.summary,
    }));
    // A run.completed that announces an epilogue: its stream stays open for the results.
    if (terminal.type === "run.completed" && (terminal.payload.epilogue?.length ?? 0) > 0) {
      this.#epilogue?.close();
      this.#epilogue = this.#stream;
    }
    this.#stream = undefined;
    void this.refresh();
  }

  #onSignal(runId: string, signal: StreamSignal): void {
    if (this.#epilogue?.runId === runId && this.#stream?.runId !== runId) {
      // The epilogue's stream ended (all results arrived, or the window closed): nothing to do.
      if (signal.kind === "closed") this.#epilogue = undefined;
      return;
    }
    if (this.#stream?.runId !== runId && signal.kind !== "closed") return;
    if (signal.kind === "open") {
      this.#reopenAttempts = 0;
      this.#set((s) => ({ ...s, connection: "open" }));
    } else if (signal.kind === "reconnecting") {
      this.#set((s) => ({ ...s, connection: "reconnecting" }));
    } else {
      if (this.#stream?.runId === runId) this.#stream = undefined;
      if (this.#state.live?.runId === runId && this.#state.live.terminal !== undefined) return;
      void this.#afterClose(runId);
    }
  }

  /** The server ended or refused the stream before a terminal event: ask what the run is doing. */
  async #afterClose(runId: string): Promise<void> {
    const res = await this.#api.getRun(runId);
    if (this.#disposed) return;
    if (!res.ok) {
      this.#set((s) => ({ ...s, connection: "lost" }));
      this.#fail(res.error);
      return;
    }
    if (isTerminalRunStatus(res.data.status) || res.data.status === "queued") {
      // Ended (204 on reconnect, or 410: events compacted) → the entries are the record.
      await this.refresh();
      return;
    }
    if (this.#reopenAttempts >= MAX_REOPEN_ATTEMPTS) {
      this.#set((s) => ({ ...s, connection: "lost" }));
      return;
    }
    const delay = this.#reopenDelay(this.#reopenAttempts);
    this.#reopenAttempts += 1;
    this.#set((s) => ({ ...s, connection: "reconnecting" }));
    this.#reopenTimer = setTimeout(() => {
      this.#reopenTimer = undefined;
      if (!this.#disposed && this.#stream === undefined && runToStream(this.#state) === runId) {
        this.#open(runId);
      }
    }, delay);
  }

  /** "Reconnect" after the stream was given up on. */
  readonly reconnect = (): void => {
    this.#reopenAttempts = 0;
    this.#closeStream();
    void this.refresh().then(() => {
      if (this.#disposed) return;
      const runId = runToStream(this.#state);
      if (runId !== undefined && this.#stream === undefined) this.#open(runId);
    });
  };

  // --- actions ----------------------------------------------------------------------------------

  /**
   * Sends a message (D17): starts a run on an idle thread, otherwise it queues. `parentEntryId`
   * branches from that entry (edit-and-regenerate); absent = continue from the leaf. The
   * Idempotency-Key makes the one automatic resend after a network error safe.
   */
  readonly send = async (
    text: string,
    parentEntryId?: string,
    attach?: MessageFiles,
  ): Promise<boolean> => {
    try {
      return await this.#send(text, parentEntryId, attach);
    } catch {
      // Whatever failed, the composer must not stay stuck: the message is offered back.
      this.#set((s) => ({ ...s, sending: undefined }));
      this.#fail(CLIENT_ERROR, text);
      return false;
    }
  };

  async #send(text: string, parentEntryId?: string, attach?: MessageFiles): Promise<boolean> {
    const threadId = this.#state.threadId;
    // One message at a time: a second Enter before the server answered is not a second message.
    if (threadId === null || this.#state.sending !== undefined) return false;
    const key = this.#newKey();
    const queues = currentRunId(this.#state) !== undefined;
    const branchFrom = parentEntryId ?? this.#state.summary?.leafEntryId ?? null;
    const followups = this.#state.followups;
    this.#set((s) => ({
      ...s,
      sending: { key, text, parentEntryId: branchFrom, queues, files: attach?.files },
      actionError: undefined,
      followups: undefined, // shown until the next send (KOBE-222)
      queuePaused: false, // sending releases a queue held by Stop
    }));
    const body = { content: text, parentEntryId, fileIds: attach?.fileIds };
    let res = await this.#api.sendMessage(threadId, body, key);
    if (!res.ok && res.error.status === 0) res = await this.#api.sendMessage(threadId, body, key);
    if (this.#disposed) return res.ok;
    if (!res.ok) {
      // Nothing was sent: the follow-ups come back with the draft (review N2).
      this.#set((s) => ({ ...s, sending: undefined, followups: s.followups ?? followups }));
      this.#fail(res.error, text);
      return false;
    }
    const { runId, queued } = res.data;
    this.#set((s) => ({
      ...s,
      // A queued message stays shown as "sending" until the queue read below lists it.
      sending: queued && s.sending ? { ...s.sending, runId } : undefined,
      announcement: queued ? "Message queued. It runs after the current one." : "Message sent.",
      announcementSeq: s.announcementSeq + 1,
      ...(queued
        ? {}
        : {
            live: { ...newLiveRun(runId), started: true },
            livePrompt: { text, parentEntryId: branchFrom, files: attach?.files },
            runs: [
              { runId, threadId, status: "running" as const, trigger: "user" as const },
              ...s.runs.filter((r) => r.status === "queued"),
            ],
          }),
    }));
    if (!queued) {
      this.#closeStream();
      this.#open(runId);
    }
    await this.refresh();
    this.#set((s) => (s.sending?.key === key ? { ...s, sending: undefined } : s));
    return true;
  }

  /** Steer now (D17): inject into the current run at Pi's next safe point. */
  readonly steer = async (text: string): Promise<boolean> => {
    const runId = currentRunId(this.#state);
    if (runId === undefined) return this.send(text);
    const res = await this.#busy("steer", () => this.#api.steer(runId, text));
    if (!res.ok) {
      this.#fail(res.error, text);
      return false;
    }
    this.#announce("Sent to the running agent.");
    return true;
  };

  /** Stop (D17): cancels the current run; queued messages stay and the next one starts. */
  /** Stop (D17): cancels the current run; queued messages are held until "Resume queue". */
  readonly stop = async (): Promise<void> => {
    const runId = currentRunId(this.#state);
    if (runId === undefined) return;
    const holds = queuedRuns(this.#state).length > 0;
    // Optimistic (KOBE-269): the part stops fading at the click; a refused cancel undoes it.
    this.#set((s) => ({ ...s, stopRequested: runId, queuePaused: holds || s.queuePaused }));
    const res = await this.#busy("stop", () => this.#api.cancel(runId));
    if (!res.ok) {
      this.#set((s) => ({
        ...s,
        queuePaused: false,
        stopRequested: s.stopRequested === runId ? undefined : s.stopRequested,
      }));
      this.#fail(res.error);
    } else this.#announce(holds ? "Stopped. The queue is paused." : "Stopping…");
  };

  readonly cancelQueued = async (runId: string): Promise<void> => {
    const res = await this.#busy(`delete:${runId}`, () => this.#api.cancel(runId));
    if (!res.ok) this.#fail(res.error);
    else this.#announce("Queued message deleted.");
    await this.refresh();
  };

  readonly editQueued = async (runId: string, text: string): Promise<boolean> => {
    const res = await this.#busy(`edit:${runId}`, () => this.#api.editQueued(runId, text));
    if (!res.ok) {
      this.#fail(res.error, text);
      await this.refresh();
      return false;
    }
    this.#announce("Queued message updated.");
    await this.refresh();
    return true;
  };

  /** "Retry from last entry" (D14): a new run of the interrupted message, ahead of the queue. */
  readonly retry = async (): Promise<void> => {
    const interrupted = this.#state.interruptedRun;
    if (!interrupted) return;
    const res = await this.#busy("retry", () => this.#api.retry(interrupted.runId));
    if (!res.ok) {
      this.#fail(res.error);
      await this.refresh();
      return;
    }
    this.#announce("Retrying.");
    this.#set((s) => ({ ...s, interruptedRun: null, livePrompt: undefined }));
    await this.refresh();
  };

  /** "Continue without retry" (D14): the interrupted thread's queue resumes. */
  readonly continueWithoutRetry = async (): Promise<void> =>
    this.#resumeQueue("Continuing without retry.");

  /** "Resume queue" after Stop: the held messages run in order. */
  readonly resumeQueue = async (): Promise<void> => this.#resumeQueue("The queue resumed.");

  /** Pause (CE10): the queued messages wait after the current run until resumed or a send. */
  readonly pauseQueue = async (): Promise<void> => {
    const threadId = this.#state.threadId;
    if (threadId === null) return;
    const res = await this.#busy("pause", () => this.#api.pauseQueue(threadId));
    if (!res.ok) {
      this.#fail(res.error);
      return;
    }
    this.#applyRuns(res.data);
    this.#announce("The queue is paused.");
  };

  /**
   * Reorder (CE10): `runIds` is the whole queue in its new order. Shown at once, with retries kept
   * first as the server keeps them (D14). The server's answer is applied as is; a stale list
   * (`queue_changed`) or any other refusal shows the error and reads the queue again.
   */
  readonly reorderQueue = async (runIds: readonly string[]): Promise<void> => {
    const threadId = this.#state.threadId;
    if (threadId === null) return;
    const retries = new Set(
      this.#state.runs.filter((r) => r.retryOfRunId !== undefined).map((r) => r.runId),
    );
    const order = [
      ...runIds.filter((id) => retries.has(id)),
      ...runIds.filter((id) => !retries.has(id)),
    ];
    this.#setQueuePositions(new Map(order.map((id, i) => [id, i + 1] as const)));
    const res = await this.#busy("reorder", () => this.#api.reorderQueue(threadId, order));
    if (!res.ok) {
      this.#fail(res.error);
      await this.refresh();
      return;
    }
    this.#applyRuns(res.data);
    this.#setQueuePositions(
      new Map(
        res.data.runs.flatMap((r) => (r.queuePos === undefined ? [] : [[r.runId, r.queuePos]])),
      ),
    );
    this.#announce("Queue reordered.");
  };

  #setQueuePositions(positions: ReadonlyMap<string, number>): void {
    this.#set((s) => ({
      ...s,
      pending: s.pending.map((m) => {
        const pos = positions.get(m.runId);
        return pos === undefined ? m : { ...m, queuePos: pos };
      }),
    }));
  }

  async #resumeQueue(announcement: string): Promise<void> {
    const threadId = this.#state.threadId;
    if (threadId === null) return;
    const res = await this.#busy("resume", () => this.#api.resumeQueue(threadId));
    if (!res.ok) {
      this.#fail(res.error);
      return;
    }
    this.#set((s) => ({ ...s, queuePaused: false }));
    this.#applyRuns({ ...res.data, queuePaused: res.data.queuePaused ?? false });
    this.#announce(announcement);
    await this.refresh();
  }

  /**
   * Chooses the thread's model for its next runs (KOBE-44): an alias the team enabled, or null for
   * the team's default. The server refuses one the team didn't enable (`model_not_enabled`).
   */
  readonly setModel = async (model: string | null): Promise<boolean> => {
    const threadId = this.#state.threadId;
    if (threadId === null) return false;
    const res = await this.#busy("model", () => this.#api.setThreadModel(threadId, model));
    if (!res.ok) {
      this.#fail(res.error);
      return false;
    }
    this.#set((s) => ({ ...s, summary: res.data }));
    this.#announce(model === null ? "The team's default model is used." : "Model changed.");
    return true;
  };

  /**
   * Regenerate with another model (CE17, KOBE-217): saves `model` as the thread's (null: follow
   * the team default), as the picker does, then sends `text` from `parentEntryId` as a new
   * version. Refused unless `canRegenerateWith`, so two choices can't race. A refused model
   * change runs nothing; a message that doesn't go puts the previous model back and keeps the
   * failure in the banner, so the thread is never left switched without its new version.
   */
  readonly regenerateWith = async (
    model: string | null,
    text: string,
    parentEntryId: string,
  ): Promise<boolean> => {
    if (!canRegenerateWith(this.#state)) return false;
    const previous = this.#state.summary?.model ?? null;
    const switching = model !== previous;
    try {
      // No await before these: each marks the thread busy at once (`model`, then `sending`).
      if (switching && !(await this.setModel(model))) return false;
      if (await this.send(text, parentEntryId)) return true;
    } catch {
      this.#fail(CLIENT_ERROR);
    }
    if (switching) await this.#restoreModel(previous);
    return false;
  };

  /** Puts the thread's previous model back after a failed regenerate, keeping its error shown. */
  async #restoreModel(previous: string | null): Promise<void> {
    const threadId = this.#state.threadId;
    const failure = this.#state.actionError ?? { error: REGENERATE_NOT_SENT };
    if (threadId !== null) {
      const res = await this.#busy("model", () => this.#api.setThreadModel(threadId, previous));
      if (res.ok) this.#set((s) => ({ ...s, summary: res.data }));
    }
    this.#set((s) => ({ ...s, actionError: failure }));
  }

  /**
   * Shares the thread with its project or the team, or makes it private again (owner only; the
   * server decides).
   */
  readonly setVisibility = async (visibility: ThreadVisibility): Promise<boolean> => {
    const threadId = this.#state.threadId;
    if (threadId === null) return false;
    const res = await this.#busy("share", () => this.#api.shareThread(threadId, visibility));
    if (!res.ok) {
      this.#fail(res.error);
      return false;
    }
    this.#set((s) => ({ ...s, summary: { ...res.data, readOnly: false } }));
    this.#announce(SHARED_ANNOUNCEMENT[visibility]);
    return true;
  };

  /**
   * Compact now (CE15, KOBE-213): Pi summarizes the older conversation (optional focus); the
   * thread is then read again, so its `compaction` marker shows the summary. A refusal (the
   * server's fixed message per code) is reported like any action's, so it is seen even when the
   * dialog was closed meanwhile, and the thread is read again (a `thread_busy` means it changed).
   */
  readonly compact = async (focus?: string): Promise<ApiResult<CompactResult>> => {
    const threadId = this.#state.threadId;
    if (threadId === null) return { ok: false, error: NO_THREAD };
    const res = await this.#busy("compact", () => this.#api.compactThread(threadId, focus));
    if (res.ok) this.#announce("The conversation was compacted.");
    else this.#fail(res.error);
    await this.refresh();
    return res;
  };

  /**
   * Forks the thread (any reader, or the owner) and returns the new thread's id: up to an entry
   * with a title ("Fork to a new thread", CE16), or the whole branch by default. A refusal is
   * the caller's to show (the fork dialog, the read-only banner), not the thread's error banner.
   */
  readonly fork = async (options?: ForkOptions): Promise<ApiResult<{ threadId: string }>> => {
    const threadId = this.#state.threadId;
    if (threadId === null) return { ok: false, error: NO_THREAD };
    return this.#busy("fork", () => this.#api.forkThread(threadId, options));
  };

  /** Shows another branch (assistant-ui's branch picker) and makes it the thread's leaf. */
  readonly switchLeaf = async (entryId: string): Promise<void> => {
    const threadId = this.#state.threadId;
    const summary = this.#state.summary;
    if (threadId === null || !summary || summary.leafEntryId === entryId) return;
    const previous = summary.leafEntryId;
    this.#leafVersion += 1;
    // Another branch: the follow-ups were for the answer that is no longer shown (review N1).
    this.#set((s) =>
      s.summary
        ? { ...s, followups: undefined, summary: { ...s.summary, leafEntryId: entryId } }
        : s,
    );
    const res = await this.#busy("leaf", () => this.#api.setLeaf(threadId, entryId));
    if (!res.ok) {
      this.#set((s) =>
        s.summary ? { ...s, summary: { ...s.summary, leafEntryId: previous } } : s,
      );
      this.#fail(res.error);
      return;
    }
    this.#set((s) => ({ ...s, summary: res.data }));
  };
}

function maxSeq(entries: readonly ThreadEntry[], floor: number): number {
  return entries.reduce((max, e) => Math.max(max, e.seq), floor);
}
