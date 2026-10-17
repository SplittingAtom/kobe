"use client";

import { bucketLabel } from "../../../../lib/admin/usage-format";

/** The axis labels: small, muted, equal-width digits. */
const TICK = "fill-console-muted text-[10px] tabular-nums";

const W = 640;
const H = 160;
const PAD = { top: 8, right: 8, bottom: 22, left: 40 };
const GAP = 2;

export interface DayRatings {
  readonly start: string;
  readonly up: number;
  readonly down: number;
}

/**
 * Thumbs up and down per UTC day as stacked bars (inline SVG, no chart library): up at the
 * bottom, down on top. Colour is not the only cue: the legend names both, each bar has a native
 * tooltip, and the figures are in the table under the chart (the accessible view).
 */
export function RatingsChart({ days }: { readonly days: readonly DayRatings[] }) {
  const max = Math.max(0, ...days.map((d) => d.up + d.down));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = days.length > 0 ? innerW / days.length : innerW;
  const barW = Math.max(1, slot - GAP);
  const height = (v: number) => (max > 0 ? (v / max) * innerH : 0);
  const labelEvery = Math.max(1, Math.ceil(days.length / 8));
  const base = PAD.top + innerH;

  return (
    <figure className="mx-0 my-4">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full"
        role="img"
        aria-label={`Ratings per day: at most ${max} on one day. The table below lists each day.`}
      >
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={base}
          y2={base}
          className="stroke-console-border stroke-1"
        />
        <text x={PAD.left - 6} y={PAD.top + 10} textAnchor="end" className={TICK}>
          {max}
        </text>
        <text x={PAD.left - 6} y={base} textAnchor="end" className={TICK}>
          0
        </text>
        {days.map((d, i) => {
          const x = PAD.left + i * slot + GAP / 2;
          const up = height(d.up);
          const down = height(d.down);
          const label = bucketLabel(d.start, "day");
          return (
            <g key={d.start}>
              <title>{`${label}: ${d.up} up, ${d.down} down`}</title>
              {up > 0 && (
                <rect
                  x={x}
                  y={base - up}
                  width={barW}
                  height={up}
                  className="fill-status-running"
                />
              )}
              {down > 0 && (
                <rect
                  x={x}
                  y={base - up - down}
                  width={barW}
                  height={down}
                  className="fill-status-failed"
                />
              )}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={H - 6} textAnchor="middle" className={TICK}>
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-sm text-console-muted">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block size-3 rounded-sm bg-status-running" /> Thumbs
          up
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block size-3 rounded-sm bg-status-failed" /> Thumbs
          down
        </span>
        <span>Per day (UTC)</span>
      </figcaption>
    </figure>
  );
}
