import { unzipSync } from "fflate";
import { scanSkillBundle } from "@kobe/skill-scanner";
import { describe, expect, it } from "vitest";
import { loadKobePackages } from "./kobe-packages.js";

/**
 * Pins each builtin Kobe skill's scan (verdict and finding rule ids), scanned exactly as the seed
 * does (the canonical zip's files). A scanner rule change that flips a builtin skill's verdict or
 * adds or drops a finding fails here, so it is seen and decided (KOBE-379 re-review). Update the
 * table deliberately, with the reason in the ticket's ledger.
 */
const PINNED: Readonly<Record<string, { verdict: string; rules: readonly string[] }>> = {
  "charts@1.0.0": { verdict: "pass", rules: [] },
  // The review demo's planted fake Stripe key (scripts/sample.py); Caution since KOBE-379 H-2.
  "code-review@1.0.0": { verdict: "caution", rules: ["secret:stripe-key"] },
  "data-analysis@1.0.0": { verdict: "pass", rules: [] },
  "docx@1.0.0": { verdict: "pass", rules: [] },
  "kobe-guide@1.0.0": { verdict: "pass", rules: [] },
  "pdf@1.0.0": { verdict: "pass", rules: [] },
  "skill-creator@1.2.0": {
    verdict: "caution",
    rules: ["network:node-http", "network:python-http", "network:socket"],
  },
  "xlsx@1.0.0": { verdict: "pass", rules: [] },
};

describe("builtin skill scans", () => {
  it("match the pinned verdicts and finding rules", async () => {
    const actual: Record<string, { verdict: string; rules: string[] }> = {};
    for (const p of await loadKobePackages()) {
      const entries = unzipSync(p.bundle.packageZip ?? p.bundle.zip);
      const scan = scanSkillBundle(
        Object.entries(entries).map(([path, bytes]) => ({ path, bytes })),
      );
      actual[`${p.name}@${p.semver}`] = {
        verdict: scan.verdict,
        rules: [...new Set(scan.findings.map((f) => `${f.category}:${f.rule}`))].sort(),
      };
    }
    expect(actual).toEqual(PINNED);
  });
});
