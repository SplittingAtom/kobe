"use client";

import { useAui } from "@assistant-ui/react";
import { useEffect, useState } from "react";
import type { BudgetStatus } from "../../lib/admin/api/budgets";
import type { RunUsage } from "../../lib/admin/api/usage";
import { formatTokens, formatUsd } from "../../lib/admin/usage-format";
import { isBusy, type ThreadState } from "../../lib/chat/thread-state";
import type { ThreadController } from "../../lib/chat/thread-controller";
import { ErrorNotice } from "../admin/error-notice";
import type { KobeThreadExtras } from "./kobe-runtime";
import { NoticeSlot } from "./slots";
import styles from "./chat.module.css";

const WAKING: Record<string, string> = {
  hibernated: "Waking your workspace…",
  first_start: "Starting your workspace for the first time…",
  rebuild: "Rebuilding your workspace…",
};

/** Connection, waking, notices and how the last run ended (D14, D16). */
function RunStatus({
  state,
  controller,
}: {
  readonly state: ThreadState;
  readonly controller: ThreadController;
}) {
  const live = state.live;
  const terminal = live?.terminal;
  return (
    <>
      {state.connection === "reconnecting" && (
        <p className={styles.banner} role="status">
          Reconnecting to the live stream… Nothing is lost: it resumes where it stopped.
        </p>
      )}
      {state.connection === "lost" && (
        <div className={styles.banner} role="alert">
          Live updates stopped. The run goes on without you; nothing is lost. This can happen when
          too many Kobe tabs or devices follow runs at once (each person can follow 16 per server):
          close some, then reconnect.{" "}
          <button type="button" onClick={controller.reconnect}>
            Reconnect
          </button>
        </div>
      )}
      {live?.waking && (
        <p className={styles.banner} role="status">
          {WAKING[live.waking] ?? WAKING.hibernated}
        </p>
      )}
      {live?.notices.map((notice, i) => (
        <NoticeSlot key={`${live.runId}:${i}`} notice={notice} />
      ))}
      {terminal?.type === "run.failed" && (
        <p className={styles.denied} role="alert">
          The run failed: {terminal.payload.error.message}
        </p>
      )}
      {terminal?.type === "run.budget_stopped" && (
        <p className={styles.notice} role="alert">
          The run stopped after its last step: {terminal.payload.message}
        </p>
      )}
      {terminal?.type === "run.interrupted" && terminal.payload.reason === "cancelled" && (
        <p className={styles.notice}>Stopped.</p>
      )}
    </>
  );
}

/** D14: an interrupted run is never retried by itself; the queue waits for the user's choice. */
function Interrupted({
  state,
  controller,
}: {
  readonly state: ThreadState;
  readonly controller: ThreadController;
}) {
  const interrupted = state.interruptedRun !== null || state.summary?.status === "interrupted";
  if (!interrupted) return null;
  const waiting = state.runs.filter((r) => r.status === "queued").length;
  return (
    <div className={styles.banner} role="alert">
      <p>
        <strong>The run was interrupted</strong> because the workspace stopped. It may have done
        part of its work, so it is not retried automatically.
        {waiting > 0 ? ` ${waiting} queued message${waiting === 1 ? " waits" : "s wait"}.` : ""}
      </p>
      <div className={styles.composerActions}>
        {state.interruptedRun !== null && (
          <button
            type="button"
            onClick={() => void controller.retry()}
            disabled={isBusy(state, "retry")}
          >
            Retry from last entry
          </button>
        )}
        <button
          type="button"
          onClick={() => void controller.continueWithoutRetry()}
          disabled={isBusy(state, "resume")}
        >
          Continue without retry
        </button>
      </div>
    </div>
  );
}

function QueuedItem({
  runId,
  text,
  position,
  state,
  controller,
}: {
  readonly runId: string;
  readonly text: string;
  readonly position: number;
  readonly state: ThreadState;
  readonly controller: ThreadController;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const save = async () => {
    const content = draft?.trim() ?? "";
    if (content === "" || content === text) {
      setDraft(null);
      return;
    }
    if (await controller.editQueued(runId, content)) setDraft(null);
  };
  return (
    <li className={styles.queueItem} aria-label={`Queued message ${position}`}>
      {editing ? (
        <>
          <label className={styles.visuallyHidden} htmlFor={`queued-${runId}`}>
            Edit queued message {position}
          </label>
          <textarea
            id={`queued-${runId}`}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft(null);
            }}
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={isBusy(state, `edit:${runId}`)}
          >
            Save
          </button>
          <button type="button" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <p className={styles.queueText}>{text}</p>
          <button type="button" onClick={() => setDraft(text)}>
            Edit
          </button>
          <button
            type="button"
            onClick={() => void controller.cancelQueued(runId)}
            disabled={isBusy(state, `delete:${runId}`)}
          >
            Delete
          </button>
        </>
      )}
    </li>
  );
}

/** D17: queued messages run in order after the current run; each can be edited or deleted. */
function Queue({
  state,
  controller,
}: {
  readonly state: ThreadState;
  readonly controller: ThreadController;
}) {
  const queued = state.pending
    .filter((m) => m.status === "queued")
    .sort((a, b) => (a.queuePos ?? 0) - (b.queuePos ?? 0));
  const sending = state.sending;
  const showSending = sending?.queues === true && !queued.some((m) => m.runId === sending.runId);
  if (queued.length === 0 && !showSending) return null;
  return (
    <section aria-label="Queued messages">
      {state.queuePaused ? (
        <div className={styles.banner} role="status">
          <p>
            <strong>Queue paused.</strong> You stopped the run, so the messages below wait until you
            resume the queue (sending a new message resumes it too).
          </p>
          <button
            type="button"
            onClick={() => void controller.resumeQueue()}
            disabled={isBusy(state, "resume")}
          >
            Resume queue
          </button>
        </div>
      ) : (
        <h3 className={styles.who}>Queued: runs after the current message</h3>
      )}
      <ol className={styles.queue}>
        {queued.map((m, i) => (
          <QueuedItem
            key={m.runId}
            runId={m.runId}
            text={m.content}
            position={i + 1}
            state={state}
            controller={controller}
          />
        ))}
        {showSending && (
          <li className={`${styles.queueItem} ${styles.pending}`}>
            <p className={styles.queueText}>{sending.text}</p>
            <span className={styles.who}>Queuing…</span>
          </li>
        )}
      </ol>
    </section>
  );
}

function ActionError({
  state,
  controller,
}: {
  readonly state: ThreadState;
  readonly controller: ThreadController;
}) {
  const aui = useAui();
  const failure = state.actionError;
  if (!failure) return null;
  return (
    <div>
      <ErrorNotice error={failure.error} />
      <div className={styles.composerActions}>
        {failure.draft !== undefined && (
          <button
            type="button"
            onClick={() => {
              aui.composer.setText(failure.draft ?? "");
              controller.clearError();
            }}
          >
            Put my message back
          </button>
        )}
        <button type="button" onClick={controller.clearError}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** The gateway writes usage within about a second of a call ending (batched). */
const USAGE_SETTLE_MS = 1_500;

/**
 * Run details: tokens and spend of the run that just ended (KOBE-43), as the model gateway
 * measured them. Fetched once per ended run; nothing is shown when the run made no model call.
 */
function RunUsageLine({
  state,
  controller,
}: {
  readonly state: ThreadState;
  readonly controller: ThreadController;
}) {
  const runId = state.live?.terminal ? state.live.runId : undefined;
  const [usage, setUsage] = useState<RunUsage | null>(null);
  useEffect(() => {
    setUsage(null);
    if (!runId) return;
    let current = true;
    const timer = setTimeout(() => {
      void controller.runUsage(runId).then((res) => {
        if (current && res.ok && res.data.calls > 0) setUsage(res.data);
      });
    }, USAGE_SETTLE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [runId, controller]);
  if (!usage || usage.runId !== runId) return null;
  const cached = usage.cacheReadTokens + usage.cacheWriteTokens;
  const parts = [
    `${formatTokens(usage.inputTokens)} input`,
    ...(cached > 0 ? [`${formatTokens(cached)} cached`] : []),
    `${formatTokens(usage.outputTokens)} output tokens`,
    `${usage.calls} model call${usage.calls === 1 ? "" : "s"}`,
    ...(usage.unpricedCalls < usage.calls ? [formatUsd(usage.costUsd)] : []),
  ];
  return (
    <p className={styles.who} aria-label="Run usage">
      {parts.join(" · ")}
      {usage.estimatedCalls > 0 ? " (partly estimated)" : ""}
    </p>
  );
}

const SCOPE_WORDS = { install: "The install's", team: "Your team's", user: "Your" } as const;

/** The budget banner's sentence for the most used budget (KOBE-42, D30 "warn the user"). */
export function budgetBannerText(status: BudgetStatus): string | null {
  const line = [...status.lines]
    .filter((l) => l.state !== "ok")
    .sort((a, b) => b.percent - a.percent)[0];
  if (!line) return null;
  const which = `${SCOPE_WORDS[line.scope]} ${line.period === "month" ? "monthly" : "daily"} ${line.unit === "tokens" ? "token" : "model"} budget`;
  return line.state === "exhausted"
    ? `${which} is used up: new messages can't start a run until it is raised or the ${line.period} ends.`
    : `${which} is ${line.percent} % used.`;
}

/** Warns at 80 % and says why runs are refused at 100 % (checked on open and after each run). */
function BudgetBanner({
  state,
  controller,
}: {
  readonly state: ThreadState;
  readonly controller: ThreadController;
}) {
  const ended = state.live?.terminal ? state.live.runId : "";
  const [status, setStatus] = useState<BudgetStatus | null>(null);
  useEffect(() => {
    let current = true;
    void controller.budgetStatus().then((res) => {
      if (current) setStatus(res.ok ? res.data : null);
    });
    return () => {
      current = false;
    };
  }, [ended, controller]);
  const sentence = status ? budgetBannerText(status) : null;
  if (!sentence || !status) return null;
  return (
    <p
      className={status.state === "exhausted" ? styles.denied : styles.banner}
      role={status.state === "exhausted" ? "alert" : "status"}
      aria-label="Budget"
    >
      {sentence}
    </p>
  );
}

export function RunPanel({ extras }: { readonly extras: KobeThreadExtras }) {
  const { controller, state } = extras;
  if (!controller) return null;
  return (
    <>
      <RunStatus state={state} controller={controller} />
      <RunUsageLine state={state} controller={controller} />
      <BudgetBanner state={state} controller={controller} />
      <Interrupted state={state} controller={controller} />
      <Queue state={state} controller={controller} />
      <ActionError state={state} controller={controller} />
    </>
  );
}
