import type { VerifiedIsolation } from "../../isolation/gate.js";
import type { OrbitEvalSettings, SandboxSettings } from "../../sandbox/config.js";
import {
  ANNOTATION_TEAM_ID,
  LABEL_MANAGED_BY,
  LABEL_ORBIT_EVAL,
  LABEL_TEAM_ID,
  MANAGED_BY,
  SANDBOX_HOSTS,
  SANDBOX_SERVICE_ACCOUNT,
  SANDBOX_UID,
} from "../../sandbox/constants.js";
import { isUuid, type KubeObject } from "../../sandbox/manifests.js";

/**
 * Pure builders for an Orbit eval (KOBE-93): one ConfigMap (the exported Orbit YAML) and one Job in
 * the team namespace, as isolated as a sandbox. The Job's pod runs under the verified gVisor/Kata
 * RuntimeClass, meets Pod Security "restricted" (and the chart's admission policy for team pods),
 * has no service account token, no Secret volumes or env, no DNS and a NetworkPolicy that lets it
 * reach the model gateway only (`evalNetworkPolicyManifest`). Its one credential is a short-lived
 * gateway token scoped to the team and this eval; provider keys never get near it.
 */

export const EVAL_CONTAINER = "eval";
export const EVAL_INPUT_DIR = "/input";
export const EVAL_INPUT_FILE = "agent.yaml";
export const EVAL_OUTPUT_DIR = "/output";
/** Finished Jobs (and their ConfigMaps, which they own) are garbage collected after this. */
export const EVAL_TTL_SECONDS = 15 * 60;
/** The token outlives the Job's deadline by this much, so a slow start never strands the Job. */
export const EVAL_TOKEN_GRACE_SECONDS = 60;
const OUTPUT_SIZE = "16Mi";
const TMP_SIZE = "512Mi";
const EVAL_EPHEMERAL = { request: "256Mi", limit: "1Gi" } as const;

export const evalJobName = (evalId: string): string => {
  if (!isUuid(evalId)) throw new TypeError("eval id must be a lowercase uuid");
  return `orbit-eval-${evalId}`;
};
export const evalConfigMapName = evalJobName;

const labels = (teamId: string, evalId: string): Record<string, string> => ({
  [LABEL_MANAGED_BY]: MANAGED_BY,
  [LABEL_TEAM_ID]: teamId,
  [LABEL_ORBIT_EVAL]: evalId,
});

/** The exported YAML as a ConfigMap (a plain input, not a credential). */
export function evalConfigMapManifest(input: {
  readonly namespace: string;
  readonly teamId: string;
  readonly evalId: string;
  readonly orbitYaml: string;
}): KubeObject {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: evalConfigMapName(input.evalId),
      namespace: input.namespace,
      labels: labels(input.teamId, input.evalId),
    },
    data: { [EVAL_INPUT_FILE]: input.orbitYaml },
  };
}

export interface EvalJobInput {
  readonly namespace: string;
  readonly teamId: string;
  readonly evalId: string;
  /** From IsolationGate.require() just before the Job is created; never a class name. */
  readonly isolation: VerifiedIsolation;
  readonly sandbox: SandboxSettings;
  readonly eval: OrbitEvalSettings;
  /** ClusterIP of the model gateway Service (no DNS in the pod). */
  readonly gatewayAddress: string;
  /** `<gateway provider>/<model>` the Job asks the gateway for. */
  readonly model: string;
  /** Short-lived gateway token scoped to this team and eval. */
  readonly token: string;
}

const gatewayUrl = (s: SandboxSettings): string => {
  const { port } = s.endpoints.modelGateway;
  return `http://${SANDBOX_HOSTS.modelGateway}${port === 80 ? "" : `:${port}`}`;
};

export function evalPodSpec(input: EvalJobInput): Record<string, unknown> {
  const { sandbox: s, eval: e } = input;
  return {
    runtimeClassName: input.isolation.runtimeClassName,
    serviceAccountName: SANDBOX_SERVICE_ACCOUNT,
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    hostNetwork: false,
    hostPID: false,
    hostIPC: false,
    restartPolicy: "Never",
    // No DNS: the gateway resolves through /etc/hosts, so DNS is no exfiltration channel.
    dnsPolicy: "None",
    dnsConfig: {
      nameservers: ["127.0.0.1"],
      searches: [],
      options: [{ name: "ndots", value: "1" }],
    },
    hostAliases: [{ ip: input.gatewayAddress, hostnames: [SANDBOX_HOSTS.modelGateway] }],
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
        name: EVAL_CONTAINER,
        image: e.image,
        imagePullPolicy: s.imagePullPolicy,
        env: [
          { name: "KOBE_MODEL_GATEWAY_URL", value: gatewayUrl(s) },
          { name: "KOBE_MODEL_SESSION_TOKEN", value: input.token },
          { name: "KOBE_EVAL_MODEL", value: input.model },
        ],
        resources: {
          requests: { ...e.resources.requests, "ephemeral-storage": EVAL_EPHEMERAL.request },
          limits: { ...e.resources.limits, "ephemeral-storage": EVAL_EPHEMERAL.limit },
        },
        securityContext: {
          allowPrivilegeEscalation: false,
          privileged: false,
          readOnlyRootFilesystem: true,
          runAsNonRoot: true,
          capabilities: { drop: ["ALL"] },
        },
        volumeMounts: [
          { name: "input", mountPath: EVAL_INPUT_DIR, readOnly: true },
          { name: "output", mountPath: EVAL_OUTPUT_DIR },
          { name: "tmp", mountPath: "/tmp" },
        ],
      },
    ],
    volumes: [
      {
        name: "input",
        configMap: { name: evalConfigMapName(input.evalId), defaultMode: 0o444 },
      },
      { name: "output", emptyDir: { sizeLimit: OUTPUT_SIZE } },
      { name: "tmp", emptyDir: { sizeLimit: TMP_SIZE } },
    ],
  };
}

/** The eval Job: one attempt (a retry is a new eval), a hard deadline, cleaned up by the TTL. */
export function evalJobManifest(input: EvalJobInput): KubeObject {
  const meta = labels(input.teamId, input.evalId);
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: evalJobName(input.evalId),
      namespace: input.namespace,
      labels: meta,
      annotations: { [ANNOTATION_TEAM_ID]: input.teamId },
    },
    spec: {
      backoffLimit: 0,
      completions: 1,
      parallelism: 1,
      activeDeadlineSeconds: input.eval.deadlineSeconds,
      ttlSecondsAfterFinished: EVAL_TTL_SECONDS,
      template: {
        metadata: { labels: { ...meta, "app.kubernetes.io/name": "kobe-orbit-eval" } },
        spec: evalPodSpec(input),
      },
    },
  };
}
