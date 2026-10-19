"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError } from "../../lib/api/client";
import {
  estimateDraftEval,
  estimateText,
  startDraftEval,
  type EvalEstimateView,
  type EvalMode,
} from "../../lib/skills/evals-api";
import { Button, Notice } from "../ui/console";
import { ErrorNotice } from "../admin/error-notice";

/** Quiet time after the last edit before the estimate is asked for again. */
export const ESTIMATE_DEBOUNCE_MS = 500;

/**
 * Run the draft's evals (KOBE-327, SK18): the estimate is shown before Run ("≈ $X, ≈ N min"),
 * and a budget or the team eval cap that would refuse the start says so instead of the button.
 * Part of the Workbench evals panel (`evals-panel.tsx`, KOBE-328).
 */
export function EvalRun({
  teamId,
  draftId,
  rev,
  flush,
  onStarted,
  running = false,
}: {
  readonly teamId: string;
  readonly draftId: string;
  /** The draft's revision: the estimate follows edits. */
  readonly rev: number;
  readonly flush: () => Promise<unknown>;
  /** Told the new eval's id once it started. */
  readonly onStarted?: (evalRunId: string) => void;
  /** An eval of this draft is queued or running: Run waits (no double start, review L5). */
  readonly running?: boolean;
}) {
  const [mode, setMode] = useState<EvalMode>("full");
  const [view, setView] = useState<EvalEstimateView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A click while a start is on its way does nothing (state updates may not have landed yet).
  const starting = useRef(false);
  // "Eval started." goes once that eval is no longer running (review L5).
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setStarted(null);
    wasRunning.current = running;
  }, [running]);

  // Debounced (review-327 L6): an autosave per keystroke must not reload the package each time.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void estimateDraftEval(teamId, draftId, mode).then((res) => {
        if (!live) return;
        setView(res.ok ? res.data : null);
        setError(res.ok ? null : res.error);
      });
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [teamId, draftId, mode, rev]);

  async function run() {
    if (starting.current) return;
    starting.current = true;
    setBusy(true);
    try {
      await flush();
      const res = await startDraftEval(teamId, draftId, mode);
      if (res.ok) {
        setStarted(res.data.evalRunId);
        onStarted?.(res.data.evalRunId);
      } else setError(res.error);
    } catch {
      setError({
        status: 0,
        code: "not_saved",
        message: "Your latest edits aren't saved yet: try again.",
      });
    } finally {
      starting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <label className="mr-3 text-sm">
        <input
          type="checkbox"
          checked={mode === "full"}
          onChange={(e) => setMode(e.target.checked ? "full" : "with_only")}
        />{" "}
        Compare with a no-skill baseline
      </label>
      {view && (
        <p className="my-2 text-sm" aria-label="Estimate">
          {estimateText(view.estimate)}
          {view.runModel.fellBack && (
            <>
              {" "}
              · runs on {view.runModel.used}: the team hasn&apos;t enabled {view.runModel.requested}
            </>
          )}
        </p>
      )}
      {view?.blocked ? (
        <Notice tone="error">
          <p>{view.blocked.message}</p>
        </Notice>
      ) : (
        <Button
          type="button"
          variant="primary"
          disabled={busy || running || !view}
          onClick={() => void run()}
        >
          Run evals
        </Button>
      )}
      {started && (
        <p role="status" className="mt-2 text-sm">
          Eval started.
        </p>
      )}
      {error && <ErrorNotice error={error} />}
    </div>
  );
}
