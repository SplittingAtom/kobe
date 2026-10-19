"use client";

import Link from "next/link";
import { listSkillEvals, type SkillEvalRun } from "../../lib/skills/evals-api";
import { evalHref } from "../../lib/skills/eval-href";
import { RUN_STATUS_TEXT, isOpen, liftText, pct, usd } from "../../lib/skills/eval-format";
import { useLiveEval } from "../../lib/skills/use-live-eval";
import type { EventSourceFactory } from "../../lib/chat/stream";
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
/** The runs of saved versions, by version seq, newest version first. */
export function byVersion(runs: readonly SkillEvalRun[]): [number, SkillEvalRun[]][] {
  const out = new Map<number, SkillEvalRun[]>();
  for (const r of runs) {
    if (r.subject.kind !== "version") continue;
    out.set(r.subject.seq, [...(out.get(r.subject.seq) ?? []), r]);
  }
  return [...out.entries()].sort((a, b) => b[0] - a[0]);
}

export function SkillEvalHistory({
  teamId,
  scope,
  skillId,
  semverOf,
  eventSource,
}: {
  readonly teamId: string;
  readonly scope: "team" | "personal";
  readonly skillId: string;
  /** Version seq → its semver, when the page knows them ("v1.2.0"; else "version 3"). */
  readonly semverOf?: (seq: number) => string | undefined;
  /** Tests inject the event stream. */
  readonly eventSource?: EventSourceFactory;
}) {
  const { state, reload } = useResource(() => listSkillEvals(teamId, scope, skillId));
  // A running eval updates here too (its stream, else polling).
  const openIds =
    state.status === "ready" ? state.data.filter((r) => isOpen(r.status)).map((r) => r.id) : [];
  useLiveEval(
    openIds,
    async () => {
      reload();
      return true;
    },
    eventSource,
  );
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
                            {RUN_STATUS_TEXT[r.status]}
                            {isOpen(r.status) && ` (${r.progress.done} of ${r.progress.total})`}
                          </TableCell>
                          <TableCell>
                            {r.mode === "full" ? "With baseline" : "Skill only"}
                          </TableCell>
                          <TableCell>{pct(r.scorecard?.passRate)}</TableCell>
                          <TableCell>{pct(r.scorecard?.baselinePassRate)}</TableCell>
                          <TableCell>{liftText(r.scorecard?.lift)}</TableCell>
                          <TableCell>
                            {pct(r.scorecard?.triggerPrecision)} / {pct(r.scorecard?.triggerRecall)}
                          </TableCell>
                          <TableCell>
                            {r.scorecard?.costUsd === undefined
                              ? "—"
                              : usd(r.scorecard.costUsd + (r.scorecard.judgeCostUsd ?? 0))}
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
