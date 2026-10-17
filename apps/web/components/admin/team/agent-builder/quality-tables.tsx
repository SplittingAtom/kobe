"use client";

import { FEEDBACK_REASONS } from "@kobe/protocol";
import type {
  AgentFeedbackTotals,
  ReasonCounts,
  VersionTotals,
} from "../../../../lib/admin/api/feedback-totals";
import { percent } from "../../../../lib/admin/orbit-score";
import { bucketLabel } from "../../../../lib/admin/usage-format";
import { REASON_LABELS } from "../../../../lib/chat/feedback";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../../ui/console";

export const NOT_ENOUGH_TO_BREAK_DOWN = "Not enough ratings to break down";

export const rateLabel = (rate: number | null): string => (rate === null ? "—" : percent(rate));
const versionLabel = (v: number | null): string => (v === null ? "Unknown version" : `v${v}`);

/** The reasons given, most often first (ties in the contract's order); "—" when none. */
export function topReasons(reasons: ReasonCounts | null): string {
  if (reasons === null) return NOT_ENOUGH_TO_BREAK_DOWN;
  const given = FEEDBACK_REASONS.filter((r) => reasons[r] > 0)
    .map((r, i) => ({ r, n: reasons[r], i }))
    .sort((a, b) => b.n - a.n || a.i - b.i);
  return given.length === 0 ? "—" : given.map((g) => `${REASON_LABELS[g.r]} (${g.n})`).join(", ");
}

export function VersionsTable({ versions }: { readonly versions: readonly VersionTotals[] }) {
  return (
    <Table caption="Ratings by version">
      <TableHead>
        <TableRow>
          <TableHeader>Version</TableHeader>
          <TableHeader numeric>Up</TableHeader>
          <TableHeader numeric>Down</TableHeader>
          <TableHeader numeric>Positive</TableHeader>
          <TableHeader>Reasons for thumbs down</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {versions.map((v) => (
          <TableRow key={v.version ?? "unknown"}>
            <TableRowHeader>{versionLabel(v.version)}</TableRowHeader>
            <TableCell numeric>{v.up}</TableCell>
            <TableCell numeric>{v.down}</TableCell>
            <TableCell numeric>{rateLabel(v.rate)}</TableCell>
            <TableCell>{topReasons(v.reasons)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Each version's ratings by model alias; a version whose models can't be shown says so. */
export function ModelsTable({ versions }: { readonly versions: readonly VersionTotals[] }) {
  return (
    <Table caption="Ratings by model" className="mt-4">
      <TableHead>
        <TableRow>
          <TableHeader>Version</TableHeader>
          <TableHeader>Model</TableHeader>
          <TableHeader numeric>Up</TableHeader>
          <TableHeader numeric>Down</TableHeader>
          <TableHeader numeric>Positive</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {versions.flatMap((v) =>
          v.models === null
            ? [
                <TableRow key={`${v.version ?? "unknown"}`}>
                  <TableRowHeader>{versionLabel(v.version)}</TableRowHeader>
                  <TableCell colSpan={4} className="text-console-muted">
                    {NOT_ENOUGH_TO_BREAK_DOWN}
                  </TableCell>
                </TableRow>,
              ]
            : v.models.map((m) => (
                <TableRow key={`${v.version ?? "unknown"}:${m.model ?? ""}`}>
                  <TableRowHeader>{versionLabel(v.version)}</TableRowHeader>
                  <TableCell>{m.model ?? "Unknown"}</TableCell>
                  <TableCell numeric>{m.up}</TableCell>
                  <TableCell numeric>{m.down}</TableCell>
                  <TableCell numeric>{rateLabel(m.rate)}</TableCell>
                </TableRow>
              )),
        )}
      </TableBody>
    </Table>
  );
}

export function DaysTable({
  series,
}: {
  readonly series: NonNullable<AgentFeedbackTotals["series"]>;
}) {
  return (
    <Table caption="Ratings per day (UTC)" hideCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Day</TableHeader>
          <TableHeader numeric>Up</TableHeader>
          <TableHeader numeric>Down</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {series.map((d) => (
          <TableRow key={d.start}>
            <TableRowHeader>
              <time dateTime={d.start.slice(0, 10)}>{bucketLabel(d.start, "day")}</time>
            </TableRowHeader>
            <TableCell numeric>{d.up}</TableCell>
            <TableCell numeric>{d.down}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
