"use client";

import { listSkillRescans, type SkillRescan } from "../../../lib/admin/api/site/skill-rescans";
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
} from "../../ui/console";
import { DateTime, ResourceView } from "../parts";
import { useResource } from "../use-resource";

const STATUS: Record<SkillRescan["status"], string> = {
  running: "Running",
  done: "Done",
  failed: "Some bundles could not be read; retried every 10 minutes",
};

function Suspended({ rescan }: { readonly rescan: SkillRescan }) {
  if (rescan.suspensions.length === 0) return <>None</>;
  const more = rescan.suspended - rescan.suspensions.length;
  return (
    <ul className="m-0 list-none p-0">
      {rescan.suspensions.map((s) => (
        <li key={`${s.scope}:${s.teamId ?? ""}:${s.skillId}:${s.version}`}>
          {s.slug} (version {s.version}, {s.scope} skill)
        </li>
      ))}
      {more > 0 ? <li>and {more} more</li> : null}
    </ul>
  );
}

/**
 * Rescans on a scanner rule-set change (KOBE-313, SK32): each rule set's rescan, its progress and
 * the versions it suspended (left out of runs until a team reviewer decides them again).
 */
export function SkillRescansSection() {
  const { state } = useResource(() => listSkillRescans());
  return (
    <Section id="skill-rescans" title="Rescans after scanner updates">
      <ResourceView state={state} label="skill rescans">
        {(data) => (
          <>
            <p>
              The scanner rule set is <code>{data.current}</code>. When it changes, every stored
              skill version is scanned again; a version that is now blocked is suspended until a
              reviewer decides it again.
            </p>
            {data.rescans.length === 0 ? (
              <EmptyState title="No rescans yet." />
            ) : (
              <Table caption="Skill rescans" hideCaption>
                <TableHead>
                  <TableRow>
                    <TableHeader>Rule set</TableHeader>
                    <TableHeader>Status</TableHeader>
                    <TableHeader>Started</TableHeader>
                    <TableHeader>Scanned</TableHeader>
                    <TableHeader>Verdict changed</TableHeader>
                    <TableHeader>Suspended</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.rescans.map((r) => (
                    <TableRow key={r.ruleSetVersion}>
                      <TableRowHeader>
                        <code className="font-normal">{r.ruleSetVersion}</code>
                      </TableRowHeader>
                      <TableCell>
                        {STATUS[r.status]}
                        {r.failed > 0 ? ` (${r.failed} unreadable)` : ""}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <DateTime value={r.startedAt} />
                      </TableCell>
                      <TableCell>{r.scanned}</TableCell>
                      <TableCell>{r.changed}</TableCell>
                      <TableCell>
                        <Suspended rescan={r} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </ResourceView>
    </Section>
  );
}
