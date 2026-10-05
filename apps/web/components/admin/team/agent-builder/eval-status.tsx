import { useEffect, useRef, useState } from "react";
import { listTeamAgentEvals, type AgentEval } from "../../../../lib/admin/api/team/agent-builder";
import { DateTime } from "../../parts";
import adminStyles from "../../admin.module.css";

export const EVAL_POLL_MS = 3000;

const percent = (rate: number): string => `${Math.round(rate * 1000) / 10}%`;
const active = (e: AgentEval | null): boolean =>
  e !== null && (e.status === "pending" || e.status === "running");

/**
 * Where a gated Publish stands (KOBE-93): progress while the Orbit eval runs (the draft is
 * "evaluating"), then the result: published, blocked above the team's limit, or errored (nothing
 * was published; try again). Polls while the eval is unfinished. `started` is the eval a Publish
 * just began; otherwise the agent's latest eval is loaded.
 */
export function EvalStatus({
  teamId,
  agentId,
  started,
  canRetry,
  onActiveChange,
  onFinished,
  onRetry,
  pollMs = EVAL_POLL_MS,
}: {
  readonly teamId: string;
  readonly agentId: string;
  readonly started: AgentEval | null;
  readonly canRetry: boolean;
  readonly onActiveChange: (active: boolean) => void;
  /** Called once when an eval this page watched ends (a pass has published a version). */
  readonly onFinished: (finished: AgentEval) => void;
  readonly onRetry: () => void;
  readonly pollMs?: number;
}) {
  const [latest, setLatest] = useState<AgentEval | null>(started);
  const watched = useRef<string | null>(started?.id ?? null);
  const callbacks = useRef({ onActiveChange, onFinished });
  callbacks.current = { onActiveChange, onFinished };

  useEffect(() => {
    if (started) {
      watched.current = started.id;
      setLatest(started);
    }
  }, [started]);

  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const res = await listTeamAgentEvals(teamId, agentId).catch(() => null);
      if (!current) return;
      if (res?.ok) {
        const next = res.data.active ?? res.data.evals[0] ?? null;
        setLatest(next);
        if (next && next.id === watched.current && !active(next)) {
          watched.current = null;
          callbacks.current.onFinished(next);
        }
        if (active(next)) watched.current = next?.id ?? null;
        if (!active(next)) return;
      } else if (watched.current === null) {
        // Nothing to wait for and the list can't be read: show nothing rather than retry forever.
        return;
      }
      timer = setTimeout(() => void refresh(), pollMs);
    };
    if (started && active(started)) timer = setTimeout(() => void refresh(), pollMs);
    else if (!started) void refresh();
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // Restart the loop when a new eval begins.
  }, [teamId, agentId, started, pollMs]);

  useEffect(() => {
    callbacks.current.onActiveChange(active(latest));
  }, [latest]);

  if (!latest) return null;
  return (
    <section aria-labelledby="eval-heading">
      <h2 id="eval-heading">Safety evaluation</h2>
      <EvalResult result={latest} canRetry={canRetry} onRetry={onRetry} />
    </section>
  );
}

function EvalResult({
  result,
  canRetry,
  onRetry,
}: {
  readonly result: AgentEval;
  readonly canRetry: boolean;
  readonly onRetry: () => void;
}) {
  const rate = result.attackSuccessRate;
  const detail =
    rate === null
      ? ""
      : `${percent(rate)} of attacks succeeded (${result.attackSuccesses ?? 0} of ${result.attempts ?? 0}); the team's limit is ${percent(result.threshold)}.`;
  switch (result.status) {
    case "pending":
    case "running":
      return (
        <p role="status">
          Evaluating draft revision {result.draftRevision}
          {result.startedAt && (
            <>
              , started <DateTime value={result.startedAt} />
            </>
          )}
          . This can take several minutes. The agent is published when it passes; you can leave this
          page.
        </p>
      );
    case "passed":
      return (
        <p role="status">
          Passed: {detail}{" "}
          {result.version !== null
            ? `Published as v${result.version}.`
            : (result.error ?? "Nothing was published.")}
        </p>
      );
    case "blocked":
      return (
        <div role="alert" className={adminStyles.error}>
          <p>
            Blocked: {detail} Nothing was published. Change the agent to resist these attacks and
            publish again.
          </p>
        </div>
      );
    case "errored":
      return (
        <div role="alert" className={adminStyles.error}>
          <p>The evaluation could not complete, so nothing was published. {result.error}</p>
          {canRetry && (
            <p>
              <button type="button" onClick={onRetry}>
                Retry publish
              </button>
            </p>
          )}
        </div>
      );
  }
}
