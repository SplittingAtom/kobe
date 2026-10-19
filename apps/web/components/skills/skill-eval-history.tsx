"use client";

import Link from "next/link";
import { listSkillEvals, type SkillEvalRun } from "../../lib/skills/evals-api";
import { evalHref } from "../../lib/skills/eval-href";
import { ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import {
  EmptyState,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../ui/console";

/**
 * Eval scorecards per saved version of a skill (KOBE-328 ac-3, SK16): every eval of each version,
 * newest version first, with its headline numbers and a link to the full scorecard. The evals of
 * a version are started from the API (or, for its draft, the Workbench) and stay in the team.
 */
const pct = (x: number | null | undefined) =>
  x === null || x === undefined ? "—" : `${Math.round(x * 100)} %`;
const STATUS: Readonly<Record<SkillEvalRun["status"], string>> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  budget_stopped: "Stopped by a budget",
};

/** The runs of saved versions, by version seq, newest version first. */
export function byVersion(runs: readonly SkillEvalRun[]): [number, SkillEvalRun[]][] {
  const out = new Map<number, SkillEvalRun[]>();
  for (const r of runs) {
    if (r.subject.kind !== "version") continue;
    out.set(r.subject.seq, [...(out.get(r.subject.seq) ?? []), r]);
  }
  return [...out.entries()].sort((a, b) => b[0] - a[0]);
}

function lift(r: SkillEvalRun): string {
  const l = r.scorecard?.lift;
  if (l === null || l === undefined) return "—";
  const p = Math.round(l * 100);
  return `${p > 0 ? "+" : ""}${p} points`;
}

export function SkillEvalHistory({
  teamId,
  scope,
  skillId,
  semverOf,
}: {
  readonly teamId: string;
  readonly scope: "team" | "personal";
  readonly skillId: string;
  /** Version seq → its semver, when the page knows them ("v1.2.0"; else "version 3"). */
  readonly semverOf?: (seq: number) => string | undefined;
}) {
  const { state } = useResource(() => listSkillEvals(teamId, scope, skillId));
  return (
    <Section
      id="skill-evals"
      title="Evals by version"
      description="Each saved version's eval scorecards, newest first. Open one for every metric and each case's runs."
    >
      <ResourceView state={state} label="eval history">
        {(runs) => {
          const versions = byVersion(runs);
          if (versions.length === 0)
            return <EmptyState title="No saved version of this skill has been evaluated yet." />;
          return (
            <>
              {versions.map(([seq, list]) => {
                const label = semverOf?.(seq) ? `v${semverOf(seq)}` : `Version ${seq}`;
                return (
                  <Table key={seq} caption={label}>
                    <TableHead>
                      <TableRow>
                        <TableHeader>Started</TableHeader>
                        <TableHeader>Status</TableHeader>
                        <TableHeader>Mode</TableHeader>
                        <TableHeader>Pass rate</TableHeader>
                        <TableHeader>Baseline</TableHeader>
                        <TableHeader>Lift</TableHeader>
                        <TableHeader>Precision / recall</TableHeader>
                        <TableHeader>Cost</TableHeader>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {list.map((r) => (
                        <TableRow key={r.id}>
                          <TableRowHeader>
                            <Link href={evalHref(r.id)}>
                              {new Date(r.startedAt).toLocaleString()}
                            </Link>
                          </TableRowHeader>
                          <TableCell>
                            {STATUS[r.status]}
                            {(r.status === "queued" || r.status === "running") &&
                              ` (${r.progress.done} of ${r.progress.total})`}
                          </TableCell>
                          <TableCell>
                            {r.mode === "full" ? "With baseline" : "Skill only"}
                          </TableCell>
                          <TableCell>{pct(r.scorecard?.passRate)}</TableCell>
                          <TableCell>{pct(r.scorecard?.baselinePassRate)}</TableCell>
                          <TableCell>{lift(r)}</TableCell>
                          <TableCell>
                            {pct(r.scorecard?.triggerPrecision)} / {pct(r.scorecard?.triggerRecall)}
                          </TableCell>
                          <TableCell>
                            {r.scorecard
                              ? `$${(r.scorecard.costUsd + r.scorecard.judgeCostUsd).toFixed(2)}`
                              : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                );
              })}
            </>
          );
        }}
      </ResourceView>
    </Section>
  );
}
