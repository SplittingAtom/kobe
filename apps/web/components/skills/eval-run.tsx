"use client";

import { useEffect, useState } from "react";
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

/**
 * Run the draft's evals (KOBE-327, SK18): the estimate is shown before Run ("≈ $X, ≈ N min"),
 * and a budget or the team eval cap that would refuse the start says so instead of the button.
 * The scorecard panel is the Workbench's (KOBE-328).
 */
export function EvalRun({
  teamId,
  draftId,
  rev,
  flush,
}: {
  readonly teamId: string;
  readonly draftId: string;
  /** The draft's revision: the estimate follows edits. */
  readonly rev: number;
  readonly flush: () => Promise<unknown>;
}) {
  const [mode, setMode] = useState<EvalMode>("full");
  const [view, setView] = useState<EvalEstimateView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void estimateDraftEval(teamId, draftId, mode).then((res) => {
      if (!live) return;
      setView(res.ok ? res.data : null);
      setError(res.ok ? null : res.error);
    });
    return () => {
      live = false;
    };
  }, [teamId, draftId, mode, rev]);

  async function run() {
    setBusy(true);
    await flush();
    const res = await startDraftEval(teamId, draftId, mode);
    setBusy(false);
    if (res.ok) setStarted(res.data.evalRunId);
    else setError(res.error);
  }

  return (
    <section aria-label="Evals" className="mt-4">
      <h2 className="m-0 mb-2 text-base font-semibold">Evals</h2>
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
        <Button type="button" variant="primary" disabled={busy || !view} onClick={() => void run()}>
          Run evals
        </Button>
      )}
      {started && (
        <p role="status" className="mt-2 text-sm">
          Eval started.
        </p>
      )}
      {error && <ErrorNotice error={error} />}
    </section>
  );
}
