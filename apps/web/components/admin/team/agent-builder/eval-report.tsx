"use client";

import Link from "next/link";
import {
  getTeamAgentEval,
  type AgentEvalDetail,
} from "../../../../lib/admin/api/team/agent-builder";
import { percent } from "../../../../lib/admin/orbit-score";
import { useTeamAccess } from "../../console-context";
import { DateTime, ResourceView } from "../../parts";
import { useResource } from "../../use-resource";
import styles from "../../admin.module.css";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string =>
  typeof v === "string" || typeof v === "number" ? String(v) : "—";
const rate = (v: unknown): string => (typeof v === "number" ? percent(v) : "—");

interface ScenarioRow {
  readonly id: string;
  readonly category: string;
  readonly attempts: string;
  readonly successes: string;
  readonly errors: string;
  readonly rate: string;
}

/** Reads the image's report defensively: it is JSON from a Job, shown only as plain text. */
function scenarios(report: unknown): readonly ScenarioRow[] {
  if (!isRecord(report) || !Array.isArray(report.scenarios)) return [];
  return report.scenarios.filter(isRecord).map((s) => ({
    id: text(s.id),
    category: text(s.category),
    attempts: text(s.attempts),
    successes: text(s.successes),
    errors: text(s.errors),
    rate: rate(s.attackSuccessRate),
  }));
}

/**
 * One Orbit eval's report (KOBE-94, from a version's score link): the result and the scenario
 * table. Every value is rendered as text by React, never as HTML.
 */
export function EvalReportPage({
  agentId,
  evalId,
}: {
  readonly agentId: string;
  readonly evalId: string;
}) {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => getTeamAgentEval(teamId, agentId, evalId));
  return (
    <>
      <p>
        <Link href={`/admin/team/agents/${encodeURIComponent(agentId)}`}>Back to the agent</Link>
      </p>
      <h1>Safety evaluation report</h1>
      <ResourceView state={state} label="the report">
        {({ eval: result }) => <Report result={result} />}
      </ResourceView>
    </>
  );
}

function Report({ result }: { readonly result: AgentEvalDetail }) {
  const rows = scenarios(result.report);
  const pack = isRecord(result.report) && isRecord(result.report.pack) ? result.report.pack : null;
  return (
    <>
      <dl>
        <dt>Status</dt>
        <dd>{result.status}</dd>
        <dt>Attack success rate</dt>
        <dd>
          {result.attackSuccessRate === null
            ? "—"
            : `${percent(result.attackSuccessRate)} (${result.attackSuccesses ?? 0} of ${result.attempts ?? 0}); limit ${percent(result.threshold)}`}
        </dd>
        {result.version !== null && (
          <>
            <dt>Version</dt>
            <dd>v{result.version}</dd>
          </>
        )}
        <dt>Finished</dt>
        <dd>
          <DateTime value={result.finishedAt} />
        </dd>
        {pack && (
          <>
            <dt>Scenario pack</dt>
            <dd>
              {text(pack.id)} v{text(pack.version)}
            </dd>
          </>
        )}
      </dl>
      {result.error && <p role="alert">{result.error}</p>}
      {rows.length === 0 ? (
        <p>This evaluation has no scenario results.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Scenarios</caption>
            <thead>
              <tr>
                <th scope="col">Scenario</th>
                <th scope="col">Category</th>
                <th scope="col">Attempts</th>
                <th scope="col">Attacks succeeded</th>
                <th scope="col">Errors</th>
                <th scope="col">Rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.id}</th>
                  <td>{r.category}</td>
                  <td>{r.attempts}</td>
                  <td>{r.successes}</td>
                  <td>{r.errors}</td>
                  <td>{r.rate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
