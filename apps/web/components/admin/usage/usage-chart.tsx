"use client";

import type { SeriesPoint } from "../../../lib/admin/api/usage";
import { bucketLabel, formatTokens, formatUsd } from "../../../lib/admin/usage-format";
import styles from "./usage.module.css";

export type ChartMetric = "cost" | "tokens";

const W = 640;
const H = 180;
const PAD = { top: 8, right: 8, bottom: 22, left: 56 };
const GAP = 2;

const valueOf = (p: SeriesPoint, metric: ChartMetric) =>
  metric === "cost" ? p.costUsd : p.inputTokens + p.outputTokens + p.cacheReadTokens;
const format = (v: number, metric: ChartMetric) =>
  metric === "cost" ? formatUsd(v) : formatTokens(v);

/**
 * One series over time as thin bars (inline SVG, no chart library). Each bar has a native
 * tooltip and the figures are also in the table below the chart (the accessible view).
 */
export function UsageChart({
  points,
  bucket,
  metric,
}: {
  readonly points: readonly SeriesPoint[];
  readonly bucket: "hour" | "day";
  readonly metric: ChartMetric;
}) {
  const values = points.map((p) => valueOf(p, metric));
  const max = Math.max(0, ...values);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = points.length > 0 ? innerW / points.length : innerW;
  const barW = Math.max(1, slot - GAP);
  const y = (v: number) => PAD.top + innerH - (max > 0 ? (v / max) * innerH : 0);
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const title = metric === "cost" ? "Spend" : "Tokens";

  return (
    <figure className={styles.figure}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={styles.chart}
        role="img"
        aria-label={`${title} per ${bucket}: highest ${format(max, metric)}`}
      >
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={PAD.top + innerH}
          y2={PAD.top + innerH}
          className={styles.axis}
        />
        <text x={PAD.left - 6} y={PAD.top + 10} textAnchor="end" className={styles.tick}>
          {format(max, metric)}
        </text>
        <text x={PAD.left - 6} y={PAD.top + innerH} textAnchor="end" className={styles.tick}>
          {format(0, metric)}
        </text>
        {points.map((p, i) => {
          const v = values[i] ?? 0;
          const x = PAD.left + i * slot + GAP / 2;
          const top = y(v);
          const height = PAD.top + innerH - top;
          return (
            <g key={p.t}>
              <rect
                x={x}
                y={PAD.top}
                width={Math.max(barW, 4)}
                height={innerH}
                className={styles.hit}
              >
                <title>{`${bucketLabel(p.t, bucket)}: ${format(v, metric)} · ${p.calls} calls`}</title>
              </rect>
              {height > 0 && (
                <rect
                  x={x}
                  y={top}
                  width={barW}
                  height={height}
                  rx={Math.min(2, barW / 2)}
                  className={styles.bar}
                  pointerEvents="none"
                />
              )}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={H - 6} textAnchor="middle" className={styles.tick}>
                  {bucketLabel(p.t, bucket)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className={styles.caption}>
        {title} per {bucket} (UTC)
      </figcaption>
    </figure>
  );
}
