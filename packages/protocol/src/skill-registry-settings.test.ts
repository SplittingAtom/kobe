import { describe, expect, it } from "vitest";
import {
  REGISTRY_SUBMISSION_DEFAULTS,
  registrySettingsUpdateSchema,
  registrySubmissionRulesSchema,
  registryScannerSchema,
  registryMirrorSchema,
  registryImportAllowlistSchema,
} from "./skill-registry-settings.js";

describe("Registry settings (KOBE-330, SK20, SK21)", () => {
  it("defaults the submission rules to the spec's table (ac-3)", () => {
    expect(registrySubmissionRulesSchema.parse({})).toEqual({
      minCases: 3,
      minNegativeCases: 1,
      minPassRate: 0.8,
      minLift: 0,
      minTriggerPrecision: 0.8,
      refuseBlockVerdict: true,
      requireLicense: true,
      requireFreshScorecard: true,
      retriesPerFailingCase: 1,
    });
    expect(REGISTRY_SUBMISSION_DEFAULTS).toEqual(registrySubmissionRulesSchema.parse({}));
  });

  it("validates each rule's range and keeps unknown keys out", () => {
    const bad = [
      { minCases: 0 },
      { minNegativeCases: -1 },
      { minPassRate: 1.2 },
      { minLift: -2 },
      { minTriggerPrecision: -0.1 },
      { retriesPerFailingCase: 4 },
      { minCases: 2, minNegativeCases: 3 },
      { autoApprove: true },
    ];
    for (const rules of bad)
      expect(registrySubmissionRulesSchema.safeParse(rules).success).toBe(false);
    expect(
      registrySubmissionRulesSchema.safeParse({ minPassRate: 0.9, minLift: -0.1 }).success,
    ).toBe(true);
  });

  it("takes an import allowlist of hosts, a scanner toggle and a mirror", () => {
    expect(
      registryImportAllowlistSchema.safeParse(["github.com", "gitlab.example.org"]).success,
    ).toBe(true);
    for (const host of ["https://github.com", "GitHub.com", "a b", "", "github.com/x/y"])
      expect(registryImportAllowlistSchema.safeParse([host]).success, host).toBe(false);
    expect(registryImportAllowlistSchema.safeParse(["a.com", "a.com"]).success).toBe(false);
    expect(registryScannerSchema.parse({})).toEqual({ external: false });
    expect(registryMirrorSchema.parse({})).toEqual({ enabled: false });
    expect(registryMirrorSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(
      registryMirrorSchema.safeParse({
        enabled: true,
        url: "https://git.example.org/kobe/catalog.git",
      }).success,
    ).toBe(true);
    expect(
      registryMirrorSchema.safeParse({ enabled: true, url: "http://x.org/r.git" }).success,
    ).toBe(false);
  });

  it("updates any subset, but at least one setting", () => {
    expect(registrySettingsUpdateSchema.safeParse({}).success).toBe(false);
    // The Registry team is never named here: it is created (review H1).
    expect(registrySettingsUpdateSchema.safeParse({ registryTeamId: null }).success).toBe(false);
    expect(registrySettingsUpdateSchema.safeParse({ judgeAlias: "smart" }).success).toBe(true);
    expect(registrySettingsUpdateSchema.safeParse({ judgeAlias: "" }).success).toBe(false);
    expect(
      registrySettingsUpdateSchema.safeParse({ evalLimits: { maxConcurrentSandboxes: 2 } }).success,
    ).toBe(true);
    expect(
      registrySettingsUpdateSchema.safeParse({
        registryTeamId: "7a1e2b3c-4d5e-4f60-8a71-92b3c4d5e6f7",
      }).success,
    ).toBe(false);
  });
});
