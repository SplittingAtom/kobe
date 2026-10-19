import type { VerifiedIsolation } from "../../isolation/gate.js";
import type { SandboxSettings, SkillScanSettings } from "../../sandbox/config.js";
import {
  ANNOTATION_TEAM_ID,
  LABEL_MANAGED_BY,
  LABEL_SKILL_SCAN,
  LABEL_TEAM_ID,
  MANAGED_BY,
  SANDBOX_SERVICE_ACCOUNT,
  SANDBOX_UID,
} from "../../sandbox/constants.js";
import { isUuid, type KubeObject } from "../../sandbox/manifests.js";

/**
 * Pure builders for an external skill scan (KOBE-341, SK32): one ConfigMap (the package zip) and
 * one Job in the Registry team's namespace, as isolated as an Orbit eval and more: the pod runs
 * under the verified gVisor/Kata RuntimeClass, meets Pod Security "restricted", has no service
 * account token, no Secret volume or env, no environment at all, no DNS, and a NetworkPolicy that
 * allows no traffic (`skillScanNetworkPolicyManifest`). It reads the package and prints its result.
 */

export const SCAN_CONTAINER = "scan";
export const SCAN_INPUT_DIR = "/input";
export const SCAN_INPUT_FILE = "package.zip";
/** Finished Jobs (and their ConfigMaps, which they own) are garbage collected after this. */
export const SCAN_TTL_SECONDS = 15 * 60;
/**
 * The largest package the scan takes: a ConfigMap holds at most 1 MiB, base64 included. A larger
 * package is not scanned (recorded as skipped); Kobe's own scanner still covers it.
 */
export const SCAN_MAX_PACKAGE_BYTES = 700 * 1024;
const TMP_SIZE = "256Mi";
const SCAN_EPHEMERAL = { request: "128Mi", limit: "512Mi" } as const;

export const scanJobName = (versionId: string): string => {
  if (!isUuid(versionId)) throw new TypeError("registry version id must be a lowercase uuid");
  return `skill-scan-${versionId}`;
};
export const scanConfigMapName = scanJobName;

const labels = (teamId: string, versionId: string): Record<string, string> => ({
  [LABEL_MANAGED_BY]: MANAGED_BY,
  [LABEL_TEAM_ID]: teamId,
  [LABEL_SKILL_SCAN]: versionId,
});

export function scanConfigMapManifest(input: {
  readonly namespace: string;
  readonly teamId: string;
  readonly versionId: string;
  readonly packageZip: Uint8Array;
}): KubeObject {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: scanConfigMapName(input.versionId),
      namespace: input.namespace,
      labels: labels(input.teamId, input.versionId),
    },
    binaryData: { [SCAN_INPUT_FILE]: Buffer.from(input.packageZip).toString("base64") },
  };
}

export interface ScanJobInput {
  readonly namespace: string;
  /** The Registry team (its namespace runs the scan, SK21). */
  readonly teamId: string;
  readonly versionId: string;
  /** From IsolationGate.require() just before the Job is created; never a class name. */
  readonly isolation: VerifiedIsolation;
  readonly sandbox: SandboxSettings;
  readonly scan: SkillScanSettings;
}

export function scanPodSpec(input: ScanJobInput): Record<string, unknown> {
  const { sandbox: s, scan } = input;
  return {
    runtimeClassName: input.isolation.runtimeClassName,
    serviceAccountName: SANDBOX_SERVICE_ACCOUNT,
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    hostNetwork: false,
    hostPID: false,
    hostIPC: false,
    restartPolicy: "Never",
    // No DNS and no hosts to reach: the scan needs no network (and its policy allows none).
    dnsPolicy: "None",
    dnsConfig: {
      nameservers: ["127.0.0.1"],
      searches: [],
      options: [{ name: "ndots", value: "1" }],
    },
    ...(s.imagePullSecrets.length > 0
      ? { imagePullSecrets: s.imagePullSecrets.map((name) => ({ name })) }
      : {}),
    securityContext: {
      runAsNonRoot: true,
      runAsUser: SANDBOX_UID,
      runAsGroup: SANDBOX_UID,
      seccompProfile: { type: "RuntimeDefault" },
    },
    containers: [
      {
        // Not "agent": the chart's admission policy lets only that container add capabilities.
        name: SCAN_CONTAINER,
        image: scan.image,
        imagePullPolicy: s.imagePullPolicy,
        args: ["--package", `${SCAN_INPUT_DIR}/${SCAN_INPUT_FILE}`],
        // No env: no credential, no endpoint (the image sets what the scanner needs offline).
        resources: {
          requests: { ...scan.resources.requests, "ephemeral-storage": SCAN_EPHEMERAL.request },
          limits: { ...scan.resources.limits, "ephemeral-storage": SCAN_EPHEMERAL.limit },
        },
        securityContext: {
          allowPrivilegeEscalation: false,
          privileged: false,
          readOnlyRootFilesystem: true,
          runAsNonRoot: true,
          capabilities: { drop: ["ALL"] },
        },
        volumeMounts: [
          { name: "input", mountPath: SCAN_INPUT_DIR, readOnly: true },
          { name: "tmp", mountPath: "/tmp" },
        ],
      },
    ],
    volumes: [
      {
        name: "input",
        configMap: { name: scanConfigMapName(input.versionId), defaultMode: 0o444 },
      },
      { name: "tmp", emptyDir: { sizeLimit: TMP_SIZE } },
    ],
  };
}

/** The scan Job: one attempt, a hard deadline, cleaned up by the TTL. */
export function scanJobManifest(input: ScanJobInput): KubeObject {
  const meta = labels(input.teamId, input.versionId);
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: scanJobName(input.versionId),
      namespace: input.namespace,
      labels: meta,
      annotations: { [ANNOTATION_TEAM_ID]: input.teamId },
    },
    spec: {
      backoffLimit: 0,
      completions: 1,
      parallelism: 1,
      activeDeadlineSeconds: input.scan.deadlineSeconds,
      ttlSecondsAfterFinished: SCAN_TTL_SECONDS,
      template: {
        metadata: { labels: { ...meta, "app.kubernetes.io/name": "kobe-skill-scan" } },
        spec: scanPodSpec(input),
      },
    },
  };
}
