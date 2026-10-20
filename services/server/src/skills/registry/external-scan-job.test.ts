import { describe, expect, it } from "vitest";
import type { VerifiedIsolation } from "../../isolation/gate.js";
import { skillScanNetworkPolicyManifest } from "../../sandbox/manifests.js";
import { SETTINGS } from "../../testing/sandbox-fixtures.js";
import {
  SCAN_PART_BYTES,
  packageParts,
  scanConfigMapManifest,
  scanJobManifest,
  scanJobName,
} from "./external-scan-job.js";

/** KOBE-341 (ac-2, ac-4): the scan Job holds the package and nothing else, and reaches nothing. */
const versionId = "00000000-0000-4000-8000-000000000341";
const teamId = "00000000-0000-4000-8000-0000000000aa";
const isolation = { runtimeClassName: "gvisor", handler: "runsc" } as unknown as VerifiedIsolation;
const scan = {
  image: "ghcr.io/splittingatom/kobe-skill-scan:0.1.0",
  deadlineSeconds: 300,
  resources: { requests: { cpu: "250m", memory: "512Mi" }, limits: { cpu: "1", memory: "2Gi" } },
};
const job = scanJobManifest({
  namespace: "kobe-team-registry",
  teamId,
  versionId,
  isolation,
  sandbox: SETTINGS,
  scan,
  parts: 2,
});
const pod = (job.spec as { template: { spec: Record<string, unknown> } }).template.spec;
const container = (pod.containers as Record<string, unknown>[])[0] ?? {};

describe("the scan Job", () => {
  it("runs isolated, with no token, no secret, no environment and no DNS", () => {
    expect(job.metadata).toMatchObject({
      name: scanJobName(versionId),
      namespace: "kobe-team-registry",
    });
    expect(pod).toMatchObject({
      runtimeClassName: "gvisor",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      dnsPolicy: "None",
      restartPolicy: "Never",
    });
    expect(pod).not.toHaveProperty("hostAliases");
    expect(container).not.toHaveProperty("env");
    expect(container).not.toHaveProperty("envFrom");
    expect(container).toMatchObject({
      image: scan.image,
      args: ["--parts", "/input"],
      securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false },
    });
    const volumes = pod.volumes as Record<string, unknown>[];
    expect(volumes.map((v) => Object.keys(v).filter((k) => k !== "name")[0])).toEqual([
      "projected",
      "emptyDir",
    ]);
    expect(volumes[0]).toMatchObject({
      projected: {
        sources: [
          { configMap: { name: `skill-scan-${versionId}-0` } },
          { configMap: { name: `skill-scan-${versionId}-1` } },
        ],
      },
    });
    expect(JSON.stringify(job)).not.toMatch(/secret/i);
    expect(job.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 300 });
  });

  it("gets the package from a ConfigMap and no network at all", () => {
    const cm = scanConfigMapManifest({
      namespace: "kobe-team-registry",
      teamId,
      versionId,
      part: 1,
      bytes: new Uint8Array([1, 2, 3]),
      owner: { name: scanJobName(versionId), uid: "u-1" },
    });
    expect(cm.binaryData).toEqual({ "part-001": "AQID" });
    // Owned by the Job from creation: it goes with the Job (review-341 L5).
    expect(cm.metadata.ownerReferences).toEqual([
      { apiVersion: "batch/v1", kind: "Job", name: scanJobName(versionId), uid: "u-1" },
    ]);
    const parts = packageParts(new Uint8Array(SCAN_PART_BYTES * 2 + 1));
    expect(parts.map((p) => p.length)).toEqual([SCAN_PART_BYTES, SCAN_PART_BYTES, 1]);
    const policy = skillScanNetworkPolicyManifest("kobe-team-registry");
    expect(policy.spec).toEqual({
      podSelector: {
        matchExpressions: [{ key: "kobe.splittingatom.io/skill-scan", operator: "Exists" }],
      },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [],
    });
  });
});
