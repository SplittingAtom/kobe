"use client";

import { useState, type ReactNode } from "react";
import type { ApiResult } from "../../../lib/api/client";
import type {
  KindUsage,
  SeriesPoint,
  UsageReport,
  UsageTotals,
} from "../../../lib/admin/api/usage";
import {
  USAGE_RANGES,
  fillSeries,
  formatTokens,
  formatUsd,
  rangeQuery,
  type UsageRangeId,
} from "../../../lib/admin/usage-format";
import {
  EmptyState,
  Field,
  FormRow,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "../../ui/console";
import { ResourceView } from "../parts";
import { useResource } from "../use-resource";
import { UsageChart, type ChartMetric } from "./usage-chart";

const HINT = "m-0 my-1 text-sm text-console-muted";

const ZERO: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
  estimatedCalls: 0,
};

function Tiles({ totals }: { readonly totals: UsageTotals }) {
  const tiles: [string, string][] = [
    ["Spend", formatUsd(totals.costUsd)],
    ["Input tokens", formatTokens(totals.inputTokens)],
    ["Cached input", formatTokens(totals.cacheReadTokens + totals.cacheWriteTokens)],
    ["Output tokens", formatTokens(totals.outputTokens)],
    ["Model calls", formatTokens(totals.calls)],
  ];
  return (
    <ul className="mx-0 my-4 grid list-none grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3 p-0">
      {tiles.map(([label, value]) => (
        <li key={label} className="box-border rounded-lg border border-console-border p-3">
          <span className="block text-2xl font-semibold tabular-nums">{value}</span>
          <span className="text-sm text-console-muted">{label}</span>
        </li>
      ))}
    </ul>
  );
}

export interface BreakdownColumn<T> {
  readonly label: string;
  readonly render: (row: T) => ReactNode;
}

/** A breakdown as a table (names first, then the figures). */
export function Breakdown<T extends UsageTotals>({
  caption,
  rows,
  name,
  rowKey,
}: {
  readonly caption: string;
  readonly rows: readonly T[];
  readonly name: BreakdownColumn<T>;
  readonly rowKey: (row: T) => string;
}) {
  if (rows.length === 0) return null;
  return (
    <Table caption={caption} className="mt-6">
      <TableHead>
        <TableRow>
          <TableHeader>{name.label}</TableHeader>
          <TableHeader numeric>Spend</TableHeader>
          <TableHeader numeric>Input</TableHeader>
          <TableHeader numeric>Cached</TableHeader>
          <TableHeader numeric>Output</TableHeader>
          <TableHeader numeric>Calls</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={rowKey(r)}>
            <TableRowHeader className="font-normal">{name.render(r)}</TableRowHeader>
            <TableCell numeric>
              {formatUsd(r.costUsd)}
              {r.unpricedCalls > 0 && (
                <span title={`${r.unpricedCalls} calls to models without a price`}> *</span>
              )}
            </TableCell>
            <TableCell numeric>{formatTokens(r.inputTokens)}</TableCell>
            <TableCell numeric>{formatTokens(r.cacheReadTokens + r.cacheWriteTokens)}</TableCell>
            <TableCell numeric>{formatTokens(r.outputTokens)}</TableCell>
            <TableCell numeric>{formatTokens(r.calls)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** `run_usage.kind` (KOBE-234): who made the calls. */
const KIND_LABELS: Readonly<Record<KindUsage["kind"], string>> = {
  run: "Runs",
  title: "Titles",
  followups: "Follow-ups",
};

function agentName(a: UsageReport["byAgent"][number]): string {
  if (!a.agentId) return "Default agent / no agent";
  return a.slug ? `${a.slug}${a.scope ? ` (${a.scope})` : ""}` : "Removed agent";
}

/**
 * The usage page body shared by the team and site consoles (KOBE-43, D30): a time range,
 * totals, spend or tokens over time, and breakdowns by team (site only), user, model and agent.
 */
export function UsageDashboard({
  load,
}: {
  readonly load: (q: { from: string; to: string }) => Promise<ApiResult<UsageReport>>;
}) {
  const [rangeId, setRangeId] = useState<UsageRangeId>("30d");
  const [metric, setMetric] = useState<ChartMetric>("cost");
  const [generation, setGeneration] = useState(0);
  return (
    <>
      <FormRow>
        <Field label="Time range">
          <Select
            value={rangeId}
            onChange={(e) => {
              setRangeId(e.target.value as UsageRangeId);
              setGeneration((g) => g + 1);
            }}
          >
            {USAGE_RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Chart">
          <Select value={metric} onChange={(e) => setMetric(e.target.value as ChartMetric)}>
            <option value="cost">Spend</option>
            <option value="tokens">Tokens</option>
          </Select>
        </Field>
      </FormRow>
      <Report key={generation} load={() => load(rangeQuery(rangeId))} metric={metric} />
    </>
  );
}

function Report({
  load,
  metric,
}: {
  readonly load: () => Promise<ApiResult<UsageReport>>;
  readonly metric: ChartMetric;
}) {
  const { state } = useResource(load);
  return (
    <ResourceView state={state} label="usage">
      {(report) => {
        const points = fillSeries<SeriesPoint>(report.series, report.range, (t) => ({
          t,
          ...ZERO,
        }));
        const { totals } = report;
        return (
          <>
            <Tiles totals={totals} />
            {totals.unpricedCalls > 0 && (
              <p className={HINT}>
                * {totals.unpricedCalls} calls used models without a price in the catalog: their
                tokens are counted, their cost is not. Site admins set prices per model.
              </p>
            )}
            {totals.estimatedCalls > 0 && (
              <p className={HINT}>
                {totals.estimatedCalls} calls had no usage report from the provider (for example a
                response cut short); their tokens are estimated generously.
              </p>
            )}
            {totals.calls === 0 ? (
              <EmptyState title="No model calls in this range." />
            ) : (
              <UsageChart points={points} bucket={report.range.bucket} metric={metric} />
            )}
            {report.byTeam && (
              <Breakdown
                caption="By team"
                rows={report.byTeam}
                rowKey={(r) => r.teamId}
                name={{ label: "Team", render: (r) => r.name }}
              />
            )}
            <Breakdown
              caption="By user"
              rows={report.byUser}
              rowKey={(r) => r.userId}
              name={{ label: "User", render: (r) => r.name ?? r.email ?? r.userId }}
            />
            <Breakdown
              caption="By model"
              rows={report.byModel}
              rowKey={(r) => r.model}
              name={{ label: "Model", render: (r) => <code>{r.model}</code> }}
            />
            <Breakdown
              caption="By agent"
              rows={report.byAgent}
              rowKey={(r) => `${r.scope ?? ""}:${r.agentId ?? ""}`}
              name={{ label: "Agent", render: agentName }}
            />
            {report.byKind && report.byKind.length > 0 && (
              <Breakdown
                caption="By kind"
                rows={report.byKind}
                rowKey={(r) => r.kind}
                name={{ label: "Kind", render: (r) => KIND_LABELS[r.kind] ?? r.kind }}
              />
            )}
          </>
        );
      }}
    </ResourceView>
  );
}
