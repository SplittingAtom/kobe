import { describe, expect, it } from "vitest";
import { percentile, runColdStartTrials, summarize } from "./cold-start.js";

describe("cold-start statistics", () => {
  it("uses nearest-rank percentiles (p95 of 20 is the 19th smallest)", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(percentile(twenty, 50)).toBe(1000);
    expect(percentile(twenty, 95)).toBe(1900);
    expect(summarize([...twenty].reverse())).toEqual({
      n: 20,
      p50: 1000,
      p95: 1900,
      min: 100,
      max: 2000,
    });
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });
});

describe("runColdStartTrials", () => {
  it("hibernates fully before every timed probe and reports totals and milestones", async () => {
    const log: string[] = [];
    let n = 0;
    const report = await runColdStartTrials("pi", 3, {
      hibernate: async () => void log.push("hibernate"),
      waitHibernated: async () => void log.push("down"),
      probe: async () => {
        log.push("probe");
        n += 1;
        return {
          totalMs: n * 1000,
          milestones: { connected: n * 600, ...(n > 1 ? { pod: 100 } : {}) },
        };
      },
    });
    expect(log).toEqual([
      "hibernate",
      "down",
      "probe",
      "hibernate",
      "down",
      "probe",
      "hibernate",
      "down",
      "probe",
    ]);
    expect(report.total).toMatchObject({ n: 3, p50: 2000, p95: 3000 });
    expect(report.milestones.connected).toMatchObject({ n: 3, p50: 1200 });
    expect(report.milestones.pod).toMatchObject({ n: 2 });
  });

  it("stops at the first failing step (a trial that cannot hibernate is not measured)", async () => {
    await expect(
      runColdStartTrials("pi", 2, {
        hibernate: async () => {
          throw new Error("busy");
        },
        waitHibernated: async () => {},
        probe: async () => ({ totalMs: 1, milestones: {} }),
      }),
    ).rejects.toThrow("busy");
  });
});
