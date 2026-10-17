"use client";

import Link from "next/link";
import {
  getTeamAgentEval,
  type AgentEvalDetail,
} from "../../../../lib/admin/api/team/agent-builder";
import { caseOutcome, caseSkips } from "../../../../lib/admin/eval-case-counts";
import { percent } from "../../../../lib/admin/orbit-score";
import {
  EmptyState,
  Notice,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { DateTime, ResourceView } from "../../parts";
import { useResource } from "../../use-resource";

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
      <PageHeader
        title="Safety evaluation report"
        back={
          <Link href={`/admin/team/agents/${encodeURIComponent(agentId)}`}>Back to the agent</Link>
        }
      />
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
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 [&_dd]:m-0 [&_dt]:font-medium">
        <dt>Status</dt>
        <dd>{result.status}</dd>
        <dt>Attack success rate</dt>
        <dd>
          {result.attackSuccessRate === null
            ? "—"
            : `${percent(result.attackSuccessRate)} (${result.attackSuccesses ?? 0} of ${result.attempts ?? 0}); limit ${percent(result.threshold)}`}
        </dd>
        <dt>Shared cases</dt>
        <dd>
          {caseOutcome(result.cases, result.threshold) ?? "None in this evaluation."}
          {caseSkips(result.cases).map((line) => (
            <span key={line} className="block text-sm text-console-muted">
              {line}
            </span>
          ))}
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
      {result.error && (
        <Notice tone="error">
          <p>{result.error}</p>
        </Notice>
      )}
      {rows.length === 0 ? (
        <EmptyState className="mt-4" title="This evaluation has no scenario results." />
      ) : (
        <Table caption="Scenarios" className="mt-4">
          <TableHead>
            <TableRow>
              <TableHeader>Scenario</TableHeader>
              <TableHeader>Category</TableHeader>
              <TableHeader numeric>Attempts</TableHeader>
              <TableHeader numeric>Attacks succeeded</TableHeader>
              <TableHeader numeric>Errors</TableHeader>
              <TableHeader numeric>Rate</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableRowHeader>{r.id}</TableRowHeader>
                <TableCell>{r.category}</TableCell>
                <TableCell numeric>{r.attempts}</TableCell>
                <TableCell numeric>{r.successes}</TableCell>
                <TableCell numeric>{r.errors}</TableCell>
                <TableCell numeric>{r.rate}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
