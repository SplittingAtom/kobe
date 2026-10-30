import type { BundleSize } from "./bundles.ts";
import { summarize, type Summary } from "./stats.ts";

/** One page load's measurements (ms, CLS unitless); a metric the browser did not give is absent. */
export interface Visit {
  readonly route: string;
  readonly metrics: Readonly<Partial<Record<MetricKey, number>>>;
}

export const METRICS = [
  { key: "ttfb", label: "TTFB ms", digits: 0 },
  { key: "fcp", label: "FCP ms", digits: 0 },
  { key: "lcp", label: "LCP ms", digits: 0 },
  { key: "cls", label: "CLS", digits: 3 },
  { key: "dcl", label: "DOM ready ms", digits: 0 },
  { key: "load", label: "Load ms", digits: 0 },
] as const;

export type MetricKey = (typeof METRICS)[number]["key"];

export interface RouteRow {
  readonly route: string;
  readonly visits: number;
  readonly bundle: BundleSize | undefined;
  readonly metrics: Readonly<Record<MetricKey, Summary>>;
}

/** Rows per route (visited ones plus `unvisited`, e.g. dynamic routes: bundle only), sorted. */
export function aggregate(
  visits: readonly Visit[],
  bundles: Readonly<Record<string, BundleSize>>,
  unvisited: readonly string[],
): RouteRow[] {
  const routes = [...new Set([...visits.map((v) => v.route), ...unvisited])].sort();
  return routes.map((route) => {
    const mine = visits.filter((v) => v.route === route);
    const metrics = Object.fromEntries(
      METRICS.map(({ key }) => [key, summarize(mine.map((v) => v.metrics[key]))]),
    ) as Record<MetricKey, Summary>;
    return { route, visits: mine.length, bundle: bundles[route], metrics };
  });
}

const DASH = "–";
const kb = (bytes: number) => String(Math.round(bytes / 1024));

function cell(s: Summary, digits: number): string {
  return s.n === 0 ? DASH : `${s.p50.toFixed(digits)} / ${s.p95.toFixed(digits)}`;
}

function bundleCell(b: BundleSize | undefined): string {
  if (!b) return DASH;
  return `${kb(b.rawBytes)} / ${b.gzipBytes === undefined ? DASH : kb(b.gzipBytes)}`;
}

/** Markdown: one row per route, `p50 / p95` per metric. */
export function renderTable(rows: readonly RouteRow[]): string {
  const header = ["Route", "Visits", "JS first load (KB raw / gz)", ...METRICS.map((m) => m.label)];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => {
      const cells = [
        `\`${r.route}\``,
        String(r.visits),
        bundleCell(r.bundle),
        ...METRICS.map((m) => cell(r.metrics[m.key], m.digits)),
      ];
      return `| ${cells.join(" | ")} |`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}
