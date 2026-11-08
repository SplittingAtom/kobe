"use client";

import type { AgentRosterRow, AgentRosterSchedule } from "@kobe/protocol";
import type { GalleryScore } from "../../lib/admin/api/agents";
import { scoreLabel } from "../../lib/admin/orbit-score";
import { formatTokens } from "../../lib/admin/usage-format";
import { GalleryScoreCell } from "../admin/gallery-score";
import { DateTime } from "../admin/parts";
import { TableCell } from "../ui/console";
import type { ResourceState } from "../admin/use-resource";

const PLACEHOLDER = "—";

/**
 * The team Inventory's cells on an Agents page row (KOBE-86, KOBE-570, AR12): runs of the team's
 * threads, the last one, tokens, the team's schedules and the Orbit score. Rows carry `usage` for
 * team admins only.
 */
export function UsageCells({ row }: { readonly row: AgentRosterRow }) {
  const u = row.usage;
  if (!u) {
    return (
      <>
        <TableCell numeric>{PLACEHOLDER}</TableCell>
        <TableCell>{PLACEHOLDER}</TableCell>
        <TableCell numeric>{PLACEHOLDER}</TableCell>
        <TableCell>{PLACEHOLDER}</TableCell>
      </>
    );
  }
  return (
    <>
      <TableCell numeric>{u.runCount.toLocaleString("en-US")}</TableCell>
      <TableCell>
        {u.lastRunAt === null ? PLACEHOLDER : <DateTime value={u.lastRunAt} compact />}
      </TableCell>
      <TableCell numeric>
        <TokenCount tokens={u.tokens} />
      </TableCell>
      <TableCell>
        <ScheduleList schedules={u.schedules} />
      </TableCell>
    </>
  );
}

/**
 * The Orbit score: the team's latest result from `usage` (team admins), else the gallery's
 * published score for a gallery row (everyone, KOBE-94).
 */
export function OrbitScore({
  row,
  galleryScores,
}: {
  readonly row: AgentRosterRow;
  readonly galleryScores: ResourceState<readonly GalleryScore[]> | null;
}) {
  const score = row.usage?.orbitScore;
  if (score && score.status !== "none") {
    return (
      <>
        {scoreLabel(score)}
        {score.at !== null && score.status !== "evaluating" && (
          <div className="text-sm text-console-muted">
            <DateTime value={score.at} compact />
          </div>
        )}
      </>
    );
  }
  if (row.kind === "gallery" && galleryScores !== null) {
    return <GalleryScoreCell agentId={row.agentId} state={galleryScores} />;
  }
  return <>{PLACEHOLDER}</>;
}

/** "1.2M" on screen; the exact count for screen readers and, as the tooltip, for a mouse. */
function TokenCount({ tokens }: { readonly tokens: number }) {
  const exact = `${tokens.toLocaleString("en-US")} tokens`;
  return (
    <span title={exact}>
      <span aria-hidden>{formatTokens(tokens)}</span>
      <span className="sr-only">{exact}</span>
    </span>
  );
}

const PAUSED_BY_LABEL: Readonly<Record<NonNullable<AgentRosterSchedule["pausedBy"]>, string>> = {
  team_admin: "paused by a team admin",
  deactivation: "paused (owner deactivated or removed)",
  agent_unavailable: "Paused: agent unavailable",
};

export function scheduleLabel(s: AgentRosterSchedule): string {
  if (s.status === "active") return "active";
  return s.pausedBy === null ? "paused" : PAUSED_BY_LABEL[s.pausedBy];
}

/** Owner and status of each of the team's schedules of the agent. */
function ScheduleList({ schedules }: { readonly schedules: readonly AgentRosterSchedule[] }) {
  if (schedules.length === 0) return <>{PLACEHOLDER}</>;
  return (
    <ul className="m-0 list-none p-0">
      {schedules.map((s) => (
        <li key={s.scheduleId}>
          {s.ownerName}: {scheduleLabel(s)}
        </li>
      ))}
    </ul>
  );
}
