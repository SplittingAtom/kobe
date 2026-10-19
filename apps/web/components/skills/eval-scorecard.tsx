"use client";

import type {
  SkillEvalCaseDetail,
  SkillEvalExecution,
  SkillEvalModeSummary,
  SkillEvalScorecard,
} from "@kobe/protocol";
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../ui/console";

/**
 * One eval's scorecard (KOBE-328 ac-1, SK16): every metric the contract defines (pass rate,
 * baseline, lift or why there is none, trigger precision and recall with their counts, cost and
 * judge cost, duration, denials, both models), then each case with each execution's status,
 * failed checks, model, cost, duration, turns, denials and a link to its eval thread. Numbers are
 * the stored card's (`computeSkillEvalScorecard`), never recomputed here.
 */

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)} %`);
const usd = (x: number) => (x < 0.01 && x > 0 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
const secs = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`;

const LIFT_WHY: Readonly<Record<string, string>> = {
  with_only: "run without a baseline",
  no_baseline_cases: "no behaviour case to compare",
  incomplete_pairs: "a baseline run errored",
};

const KIND_LABEL: Readonly<Record<SkillEvalCaseDetail["kind"], string>> = {
  behaviour: "Behaviour",
  positive_trigger: "Should trigger",
  negative_trigger: "Should not trigger",
};

/** Where an eval thread opens (team content; hidden from the member's thread list). */
export const evalThreadHref = (threadId: string) => `/?thread=${threadId.toLowerCase()}`;

function lift(card: SkillEvalScorecard): string {
  if (card.lift === null) return `— (${LIFT_WHY[card.liftUnavailable ?? ""] ?? "unavailable"})`;
  const points = Math.round(card.lift * 100);
  return `${points > 0 ? "+" : ""}${points} points`;
}

function Summary({
  label,
  s,
}: {
  readonly label: string;
  readonly s: SkillEvalModeSummary | null;
}) {
  if (!s) return null;
  return (
    <TableRow>
      <TableRowHeader>{label}</TableRowHeader>
      <TableCell>{pct(s.passRate)}</TableCell>
      <TableCell>
        {s.passed} passed, {s.failed} failed, {s.errored} errored, {s.timedOut} timed out (of{" "}
        {s.executions})
      </TableCell>
      <TableCell>{usd(s.meanCostUsd)}</TableCell>
      <TableCell>{secs(s.meanDurationMs)}</TableCell>
      <TableCell>{s.deniedToolCalls}</TableCell>
    </TableRow>
  );
}

function ExecutionCell({ e }: { readonly e: SkillEvalExecution | null }) {
  if (!e) return <TableCell>—</TableCell>;
  const failed = e.checks.filter((c) => !c.passed);
  return (
    <TableCell>
      <Badge tone={e.status === "passed" ? "done" : e.status === "failed" ? "failed" : "attention"}>
        {e.status.replace("_", " ")}
      </Badge>
      {e.attempts === 2 && <span className="ml-1 text-xs">(retried)</span>}
      {failed.length > 0 && (
        <ul className="m-0 mt-1 list-none p-0 text-xs">
          {failed.map((c) => (
            <li key={c.check}>
              {c.check}: {c.reason}
              {c.detail ? ` (${c.detail})` : ""}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 text-xs">
        {e.model}
        {e.requestedModel && ` (the team hasn't enabled ${e.requestedModel})`} ·{" "}
        {usd(e.totalCostUsd)}
        {e.judgeCostUsd > 0 && ` + judge ${usd(e.judgeCostUsd)}`} · {secs(e.totalDurationMs)} ·{" "}
        {e.turns} turns · {e.deniedToolCalls} denied
        {e.triggered !== null && ` · ${e.triggered ? "triggered" : "not triggered"}`}
      </div>
      {e.threadId && (
        <a className="text-xs" href={evalThreadHref(e.threadId)}>
          Open the run
        </a>
      )}
    </TableCell>
  );
}

export function EvalScorecard({ card }: { readonly card: SkillEvalScorecard }) {
  const t = card.triggerCounts;
  return (
    <div aria-label="Scorecard">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>Pass rate</dt>
        <dd>{pct(card.passRate)}</dd>
        <dt>Baseline pass rate</dt>
        <dd>{pct(card.baselinePassRate)}</dd>
        <dt>Lift</dt>
        <dd>{lift(card)}</dd>
        <dt>Trigger precision</dt>
        <dd>
          {pct(card.triggerPrecision)} ({t.tp} right of {t.tp + t.fp} triggers)
        </dd>
        <dt>Trigger recall</dt>
        <dd>
          {pct(card.triggerRecall)} ({t.tp} of {t.tp + t.fn} that should)
        </dd>
        <dt>Cost</dt>
        <dd>
          {usd(card.costUsd)} runs + {usd(card.judgeCostUsd)} judge
        </dd>
        <dt>Cases</dt>
        <dd>
          {card.cases} ({card.baselineCases} with a baseline, {card.negativeTriggerCases} should not
          trigger)
        </dd>
        <dt>Run model</dt>
        <dd>
          {card.runModel.used}
          {card.runModel.fellBack &&
            ` (the suite asks for ${card.runModel.requested}, which the team hasn't enabled)`}
        </dd>
        <dt>Judge</dt>
        <dd>
          {card.judgeModel
            ? `${card.judgeModel.alias} (${card.judgeModel.source === "site" ? "the Site's judge" : "the team's"})`
            : "none (no rubric)"}
        </dd>
      </dl>
      <Table>
        <TableHead>
          <TableRow>
            <TableHeader>Mode</TableHeader>
            <TableHeader>Pass rate</TableHeader>
            <TableHeader>Results</TableHeader>
            <TableHeader>Mean cost</TableHeader>
            <TableHeader>Mean duration</TableHeader>
            <TableHeader>Denied tool calls</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          <Summary label="With the skill" s={card.with} />
          <Summary label="Without (baseline)" s={card.without} />
        </TableBody>
      </Table>
      <Table>
        <TableHead>
          <TableRow>
            <TableHeader>Case</TableHeader>
            <TableHeader>With the skill</TableHeader>
            <TableHeader>Without</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {card.details.map((d) => (
            <TableRow key={d.caseId}>
              <TableRowHeader>
                {d.caseId}
                <div className="text-xs">{KIND_LABEL[d.kind]}</div>
              </TableRowHeader>
              <ExecutionCell e={d.with} />
              <ExecutionCell e={d.without} />
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
