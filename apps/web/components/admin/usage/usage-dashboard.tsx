"use client";

import { useState, type ReactNode } from "react";
import type { ApiResult } from "../../../lib/api/client";
import type { SeriesPoint, UsageReport, UsageTotals } from "../../../lib/admin/api/usage";
import {
  USAGE_RANGES,
  fillSeries,
  formatTokens,
  formatUsd,
  rangeQuery,
  type UsageRangeId,
} from "../../../lib/admin/usage-format";
import { ResourceView } from "../parts";
import { useResource } from "../use-resource";
import { UsageChart, type ChartMetric } from "./usage-chart";
import adminStyles from "../admin.module.css";
import styles from "./usage.module.css";

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
    <ul className={styles.tiles}>
      {tiles.map(([label, value]) => (
        <li key={label} className={styles.tile}>
          <span className={styles.tileValue}>{value}</span>
          <span className={styles.tileLabel}>{label}</span>
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
    <div className={`${adminStyles.tableWrap} ${styles.section}`}>
      <table className={adminStyles.table}>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{name.label}</th>
            <th scope="col" className={styles.num}>
              Spend
            </th>
            <th scope="col" className={styles.num}>
              Input
            </th>
            <th scope="col" className={styles.num}>
              Cached
            </th>
            <th scope="col" className={styles.num}>
              Output
            </th>
            <th scope="col" className={styles.num}>
              Calls
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              <td>{name.render(r)}</td>
              <td className={styles.num}>
                {formatUsd(r.costUsd)}
                {r.unpricedCalls > 0 && (
                  <span title={`${r.unpricedCalls} calls to models without a price`}> *</span>
                )}
              </td>
              <td className={styles.num}>{formatTokens(r.inputTokens)}</td>
              <td className={styles.num}>{formatTokens(r.cacheReadTokens + r.cacheWriteTokens)}</td>
              <td className={styles.num}>{formatTokens(r.outputTokens)}</td>
              <td className={styles.num}>{formatTokens(r.calls)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function agentName(a: UsageReport["byAgent"][number]): string {
  if (!a.agentId) return "Default agent / no agent";
  return a.slug ? `${a.slug}${a.scope ? ` (${a.scope})` : ""}` : "Removed agent";
}

/**
 * The usage page body shared by the team and install consoles (KOBE-43, D30): a time range,
 * totals, spend or tokens over time, and breakdowns by team (install only), user, model and agent.
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
      <div className={styles.controls}>
        <label>
          Time range
          <select
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
          </select>
        </label>
        <label>
          Chart
          <select value={metric} onChange={(e) => setMetric(e.target.value as ChartMetric)}>
            <option value="cost">Spend</option>
            <option value="tokens">Tokens</option>
          </select>
        </label>
      </div>
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
              <p className={adminStyles.hint}>
                * {totals.unpricedCalls} calls used models without a price in the catalog: their
                tokens are counted, their cost is not. Install admins set prices per model.
              </p>
            )}
            {totals.estimatedCalls > 0 && (
              <p className={adminStyles.hint}>
                {totals.estimatedCalls} calls had no usage report from the provider (for example a
                response cut short); their tokens are estimated generously.
              </p>
            )}
            {totals.calls === 0 ? (
              <p>No model calls in this range.</p>
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
          </>
        );
      }}
    </ResourceView>
  );
}
