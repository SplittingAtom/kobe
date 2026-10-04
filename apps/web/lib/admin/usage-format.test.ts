import { describe, expect, it } from "vitest";
import { bucketLabel, fillSeries, formatTokens, formatUsd, rangeQuery } from "./usage-format";

describe("usage formatting", () => {
  it("formats tokens compactly", () => {
    expect([950, 12_345, 4_200_000, 1_500_000_000, 100_000].map(formatTokens)).toEqual([
      "950",
      "12.3k",
      "4.2M",
      "1.5B",
      "100k",
    ]);
  });

  it("formats dollars with precision for small amounts", () => {
    expect([0, 0.0042, 0.25, 4.5, 1234.5].map(formatUsd)).toEqual([
      "$0.00",
      "$0.0042",
      "$0.25",
      "$4.50",
      "$1,234.50",
    ]);
  });

  it("builds a range ending now and labels buckets in UTC", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    expect(rangeQuery("7d", now)).toEqual({
      from: "2026-09-27T12:00:00.000Z",
      to: "2026-10-04T12:00:00.000Z",
    });
    expect(bucketLabel("2026-10-04T09:00:00Z", "hour")).toBe("09:00");
    expect(bucketLabel("2026-10-04T00:00:00Z", "day")).toBe("Oct 4");
  });

  it("fills empty buckets with zeros", () => {
    const filled = fillSeries(
      [{ t: "2026-10-02T00:00:00.000Z", v: 3 }],
      { from: "2026-10-01T05:00:00Z", to: "2026-10-04T00:00:00Z", bucket: "day" },
      (t) => ({ t, v: 0 }),
    );
    expect(filled.map((p) => p.v)).toEqual([0, 3, 0]);
  });
});
