import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregate, renderTable, type Visit } from "./table.ts";

const visits: Visit[] = [
  { route: "/", metrics: { ttfb: 100, fcp: 300, lcp: 500, cls: 0.01, load: 900 } },
  { route: "/", metrics: { ttfb: 120, fcp: 320, lcp: 700, cls: 0, load: 1000 } },
  { route: "/threads", metrics: { ttfb: 90 } },
];

describe("aggregate", () => {
  it("groups visits by route and summarizes each metric", () => {
    const rows = aggregate(visits, { "/": { rawBytes: 2_100_000, gzipBytes: 650_000 } }, [
      "/me/agents/[id]",
    ]);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0]?.metrics["lcp"], { n: 2, p50: 500, p95: 700 });
    assert.deepEqual(rows[0]?.bundle, { rawBytes: 2_100_000, gzipBytes: 650_000 });
    assert.equal(rows[1]?.route, "/me/agents/[id]");
    assert.equal(rows[1]?.visits, 0);
    assert.deepEqual(rows[2]?.metrics["lcp"], { n: 0, p50: Number.NaN, p95: Number.NaN });
  });
});

describe("renderTable", () => {
  it("writes one markdown row per route: p50 / p95 per metric, KB, dashes for gaps", () => {
    const md = renderTable(
      aggregate(visits, { "/": { rawBytes: 2_100_000, gzipBytes: 650_000 } }, []),
    );
    const lines = md.trim().split("\n");
    assert.equal(
      lines[0],
      "| Route | Visits | JS first load (KB raw / gz) | TTFB ms | FCP ms | LCP ms | CLS | DOM ready ms | Load ms |",
    );
    assert.match(lines[1] ?? "", /^\|( ?-+ ?\|)+$/);
    assert.equal(
      lines[2],
      "| `/` | 2 | 2051 / 635 | 100 / 120 | 300 / 320 | 500 / 700 | 0.000 / 0.010 | – | 900 / 1000 |",
    );
    assert.equal(lines[3], "| `/threads` | 1 | – | 90 / 90 | – | – | – | – | – |");
  });
});
