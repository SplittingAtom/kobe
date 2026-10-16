"use client";

import { ClockIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import {
  formatElapsed,
  phaseText,
  queuedMessages,
  runPhase,
  runStartedAt,
  steeringMode,
  type RunPhase,
  type SteeringMode,
} from "../../lib/chat/steering";
import { stopBinding } from "../../lib/chat/thread-commands";
import type { ThreadController } from "../../lib/chat/thread-controller";
import { currentRunId, isBusy, type ThreadState } from "../../lib/chat/thread-state";
import { useBudgetFinishing, useElapsed, useThrottledText } from "../../lib/chat/use-steering";
import { cn } from "../../lib/utils";
import { IconAction } from "../shell/icon-action";
import { toneClass } from "../ui/status";
import { scrollToPendingApproval } from "./approval-card";
import { Button } from "../ui/button";
import { useDraftAgentName } from "./agent-picker";
import { useSteer } from "./composer-steer";
import type { KobeThreadExtras } from "./kobe-runtime";
import { SteeringQueue } from "./steering-queue";

/** Phase changes reach screen readers at most this often (polite, latest wins). */
export const PHASE_ANNOUNCE_MS = 2_000;

/** The composer's Steer key (CE10), also shown in the Steer now tooltip. */
export const STEER_SHORTCUT = "Mod+Shift+Enter";

/** Since the run started; a run this tab saw start without a time counts from first sight. */
function Elapsed({ since, runId }: { readonly since: string | undefined; readonly runId: string }) {
  const [seen, setSeen] = useState({ runId, at: new Date().toISOString() });
  if (seen.runId !== runId) setSeen({ runId, at: new Date().toISOString() });
  const ms = useElapsed(since ?? seen.at);
  if (ms === undefined) return null;
  return <span className="tabular-nums">{formatElapsed(ms)}</span>;
}

/** Row 1: agent · model · elapsed · phase; or why nothing runs while the panel is open. */
function StatusRow({
  state,
  mode,
  phase,
}: {
  readonly state: ThreadState;
  readonly mode: SteeringMode;
  readonly phase: RunPhase | undefined;
}) {
  const draftAgent = useDraftAgentName();
  const agent = state.summary?.agentName ?? (state.summary?.agentId == null ? draftAgent : null);
  const model = state.live?.model ?? state.agentModel ?? state.summary?.model ?? "Default model";
  if (mode === "interrupted") {
    const waiting = queuedMessages(state).length;
    return (
      <p className="m-0 text-sm" role="alert">
        <strong>The run was interrupted</strong> because the workspace stopped. It may have done
        part of its work, so it is not retried automatically.
        {waiting > 0 ? ` ${waiting} queued message${waiting === 1 ? " waits" : "s wait"}.` : ""}
      </p>
    );
  }
  if (!phase) {
    return (
      <p className="text-muted-foreground m-0 text-xs">
        {state.queuePaused ? (
          <>
            <strong className="text-foreground">Queue paused.</strong> The messages below wait until
            you resume the queue (sending a new message resumes it too).
          </>
        ) : (
          "Queued: the next message starts in a moment"
        )}
      </p>
    );
  }
  return (
    <p className="text-muted-foreground m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
      {agent && <span className="text-foreground truncate font-medium">{agent}</span>}
      {agent && <span aria-hidden>·</span>}
      <span className="truncate">{model}</span>
      <span aria-hidden>·</span>
      <Elapsed since={runStartedAt(state)} runId={currentRunId(state) ?? ""} />
      <span aria-hidden>·</span>
      {phase.kind === "approval" ? (
        <ApprovalPhase reader={state.summary?.readOnly === true} />
      ) : (
        <span data-phase={phase.kind} className="text-foreground">
          {phaseText(phase)}
        </span>
      )}
    </p>
  );
}

/**
 * "Waiting for your approval" above the composer until the approval is decided (KOBE-301): amber
 * with a clock, and Show to bring the card back into view when the member scrolled away.
 */
function ApprovalPhase({ reader }: { readonly reader: boolean }) {
  return (
    <>
      <span
        data-phase="approval"
        data-kobe-approval-note
        className={cn("inline-flex items-center gap-1 font-medium", toneClass("attention"))}
      >
        <ClockIcon aria-hidden className="size-3.5 shrink-0" />
        {phaseText({ kind: "approval" })}
      </span>
      {!reader && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto px-1 py-0 text-xs"
          onClick={() => scrollToPendingApproval()}
        >
          Show
        </Button>
      )}
    </>
  );
}

/** The Stop button's red tint, from the status colours (app/theme.css, Tailwind names). */
export const STOP_TINT =
  "border-status-failed bg-status-failed-bg text-status-failed hover:bg-status-failed-bg hover:text-status-failed dark:bg-status-failed-bg dark:hover:bg-status-failed-bg dark:border-status-failed";

/** Row 3: Steer now and Stop while a run holds the thread; Retry and Continue when interrupted. */
function ControlsRow({
  extras,
  controller,
  mode,
}: {
  readonly extras: KobeThreadExtras;
  readonly controller: ThreadController;
  readonly mode: SteeringMode;
}) {
  const { state } = extras;
  const { steer, unavailable } = useSteer(extras);
  const queued = queuedMessages(state).length;
  if (mode === "interrupted") {
    return (
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {state.interruptedRun !== null && (
          <Button
            type="button"
            size="xs"
            onClick={() => void controller.retry()}
            disabled={isBusy(state, "retry")}
          >
            Retry from last entry
          </Button>
        )}
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => void controller.continueWithoutRetry()}
          disabled={isBusy(state, "resume")}
        >
          Continue without retry
        </Button>
      </div>
    );
  }
  const running = currentRunId(state) !== undefined;
  return (
    <div className="flex items-center justify-end gap-1">
      {queued > 0 &&
        (state.queuePaused ? (
          <IconAction
            command="resume-queue"
            size="sm"
            side="top"
            disabled={isBusy(state, "resume")}
            onClick={() => void controller.resumeQueue()}
          />
        ) : (
          running && (
            <IconAction
              command="pause-queue"
              size="sm"
              side="top"
              disabled={isBusy(state, "pause")}
              onClick={() => void controller.pauseQueue()}
            />
          )
        ))}
      {running && (
        <>
          <IconAction
            command="steer"
            shortcut={STEER_SHORTCUT}
            size="sm"
            side="top"
            description={unavailable}
            disabled={unavailable !== undefined}
            onClick={() => void steer()}
          />
          {/* Red-tinted while the run streams (KOBE-301): the failed/denied status colour. */}
          <IconAction
            command="stop"
            size="sm"
            side="top"
            variant="outline"
            data-kobe-stop
            className={STOP_TINT}
            disabled={isBusy(state, "stop")}
            onClick={stopBinding(controller, state).onSelect}
          >
            <SquareIcon aria-hidden className="size-3 fill-current" />
          </IconAction>
        </>
      )}
    </div>
  );
}

/**
 * The steering panel (CE10, KOBE-206), docked above the composer input in the fixed footer. Zero
 * height while the thread is idle; it expands (a grid-row transition, none under reduced motion)
 * while a run is active, queued, waiting for approval or interrupted. Rows: status, queue,
 * controls. Approval cards stay in the thread (KOBE-37); a reader of a shared thread sees the
 * status only. Phase changes go to a polite live region, throttled.
 */
export function SteeringPanel({ extras }: { readonly extras: KobeThreadExtras }) {
  const { controller, state } = extras;
  const runId = currentRunId(state);
  const reader = state.summary?.readOnly === true;
  const toolResults = Object.values(state.live?.tools ?? {}).filter((t) => t.result).length;
  // The budget read is the viewer's own: it says something about the run only for its owner.
  const finishing = useBudgetFinishing(
    reader ? undefined : controller?.budgetStatus,
    runId,
    toolResults,
  );
  const phase = runPhase(state, finishing && !reader);
  const mode = controller ? steeringMode(state, phase) : "idle";
  const said = useThrottledText(
    mode === "interrupted" ? "" : phase ? phaseText(phase) : "",
    PHASE_ANNOUNCE_MS,
  );
  // A reader of a shared thread only follows the run: no queue, controls or interrupted choices.
  const open = mode !== "idle" && (!reader || phase !== undefined);
  return (
    // A landmark only while open: an empty "Steering" region would be noise for screen readers.
    <div
      role={open ? "region" : undefined}
      aria-label={open ? "Steering" : undefined}
      data-state={open ? mode : "idle"}
      data-kobe-steering
      className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out data-[state=active]:grid-rows-[1fr] data-[state=interrupted]:grid-rows-[1fr] data-[state=queued]:grid-rows-[1fr] data-[state=waiting]:grid-rows-[1fr] motion-reduce:transition-none"
    >
      <div className="min-h-0 overflow-hidden" inert={!open || undefined}>
        {open && controller && (
          <div className="bg-muted/30 mb-2 flex flex-col gap-1.5 rounded-xl border px-3 py-2">
            <StatusRow state={state} mode={mode} phase={phase} />
            {!reader && <SteeringQueue state={state} controller={controller} />}
            {!reader && <ControlsRow extras={extras} controller={controller} mode={mode} />}
          </div>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite" data-kobe-phase-live>
        {said}
      </p>
    </div>
  );
}
