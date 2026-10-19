import { describe, expect, it } from "vitest";
import { evalResourceQuotaManifest, memberResourceQuotaManifest } from "./eval-manifests.js";
import { POD_SCOPED_QUOTA_KEYS, evalQuotaHard, teamQuotaHard } from "./eval-quota.js";
import { SETTINGS } from "../testing/sandbox-fixtures.js";

/**
 * PR #316 CI: the API server refused `kobe-skill-eval-quota` ("unsupported scope applied to
 * resource"). A PriorityClass-scoped quota may only count pods, CPU and memory (checked against
 * k3s 1.34.6, 2026-10-19: ephemeral storage is refused too), so both scoped quotas are built
 * from those keys alone, whatever `teamQuota` and the pod resources hold.
 */
const ALLOWED = [
  "pods",
  "cpu",
  "memory",
  "requests.cpu",
  "requests.memory",
  "limits.cpu",
  "limits.memory",
];

describe("the scoped ResourceQuotas (KOBE-325, PR #316)", () => {
  const busy = {
    ...SETTINGS,
    teamQuota: {
      ...SETTINGS.teamQuota,
      pods: "40",
      "requests.storage": "500Gi",
      persistentvolumeclaims: "40",
      services: "10",
      "count/secrets": "50",
      "requests.ephemeral-storage": "100Gi",
      "limits.ephemeral-storage": "200Gi",
      "requests.nvidia.com/gpu": "2",
    },
  };
  for (const [label, settings] of [
    ["the test settings", SETTINGS],
    ["a quota with every kind of key", busy],
  ] as const) {
    it(`holds only keys the PriorityClass scope allows (${label})`, () => {
      expect([...POD_SCOPED_QUOTA_KEYS].sort()).toEqual([...ALLOWED].sort());
      for (const m of [
        evalResourceQuotaManifest("kobe-team-x", settings),
        memberResourceQuotaManifest("kobe-team-x", settings),
      ]) {
        const spec = m.spec as { hard: Record<string, string>; scopeSelector: unknown };
        expect(spec.scopeSelector).toBeDefined();
        for (const key of Object.keys(spec.hard))
          expect(ALLOWED, `${m.metadata.name}: ${key}`).toContain(key);
        expect(Object.keys(spec.hard).length).toBeGreaterThan(0);
      }
    });
  }

  it("still adds the eval share's ephemeral storage to the unscoped team quota", () => {
    const s = {
      ...SETTINGS,
      teamQuota: { ...SETTINGS.teamQuota, "limits.ephemeral-storage": "10Gi" },
    };
    expect(evalQuotaHard(s)).not.toHaveProperty("limits.ephemeral-storage");
    expect(teamQuotaHard(s)["limits.ephemeral-storage"]).not.toBe("10Gi");
  });
});
