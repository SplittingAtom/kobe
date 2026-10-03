import { createIsolationGate, type IsolationGate } from "../isolation/gate.js";
import type { RuntimeClassLike } from "../isolation/runtime-class.js";
import type { SandboxSettings, SessionKeys } from "../sandbox/config.js";
import type { TeamRef } from "../sandbox/manifests.js";
import type { FakeKube } from "./fake-kube.js";

export const TEAM: TeamRef = { id: "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e", slug: "finance" };
export const OTHER_TEAM: TeamRef = {
  id: "1c6f9a2d-3e4b-4c6d-9eaf-1a2b3c4d5e6f",
  slug: "marketing",
};
export const USER = "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70";
export const OTHER_USER = "3e8b1c4f-5a6d-4e8f-9ab1-3c4d5e6f7081";

const podLabels = (component: string) => ({
  "app.kubernetes.io/name": "kobe",
  "app.kubernetes.io/instance": "kobe",
  "app.kubernetes.io/component": component,
});

export const SETTINGS: SandboxSettings = {
  image: "ghcr.io/splittingatom/kobe-sandbox:0.1.0",
  imagePullPolicy: "IfNotPresent",
  imagePullSecrets: [],
  releaseNamespace: "kobe",
  serverServiceAccount: "kobe-server",
  managerClusterRole: "kobe-abc-sandbox-manager",
  endpoints: {
    server: {
      service: "kobe-server",
      port: 8081,
      targetPort: 8081,
      podLabels: podLabels("server"),
    },
    modelGateway: {
      service: "kobe-bifrost",
      port: 8080,
      targetPort: 8080,
      podLabels: podLabels("bifrost"),
    },
    mcpProxy: {
      service: "kobe-mcp-proxy",
      port: 80,
      targetPort: 8080,
      podLabels: podLabels("mcp-proxy"),
    },
    egressProxy: {
      service: "kobe-egress-proxy",
      port: 80,
      targetPort: 8080,
      podLabels: podLabels("egress-proxy"),
    },
  },
  resources: {
    requests: { cpu: "500m", memory: "1Gi" },
    limits: { cpu: "2", memory: "4Gi" },
  },
  ephemeralStorage: { request: "1Gi", limit: "4Gi" },
  modelGatewayAccess: false,
  workspace: { size: "10Gi", storageClass: "" },
  tmpSize: "2Gi",
  homeSize: "1Gi",
  teamQuota: {
    "requests.cpu": "20",
    "requests.memory": "40Gi",
    "limits.cpu": "40",
    "limits.memory": "80Gi",
    "requests.ephemeral-storage": "40Gi",
    "limits.ephemeral-storage": "160Gi",
    "requests.storage": "500Gi",
    persistentvolumeclaims: "50",
    pods: "50",
  },
  warmPool: { replicasPerTeam: 1 },
  hibernation: { enabled: true, idleMinutes: 15, sweepSeconds: 60 },
};

export const KEYS: SessionKeys = {
  "kobe.sandbox-wire": "w".repeat(40),
  "kobe.model-gateway": "m".repeat(40),
  "kobe.mcp-proxy": "p".repeat(40),
  "kobe.egress-proxy": "e".repeat(40),
};

export const CLUSTER_IPS = {
  "kobe-server": "10.43.0.10",
  "kobe-bifrost": "10.43.0.11",
  "kobe-mcp-proxy": "10.43.0.12",
  "kobe-egress-proxy": "10.43.0.13",
} as const;

/** RuntimeClasses and the release's Services, as a real cluster has them. */
export function seedCluster(fake: FakeKube, handler = "runsc"): void {
  fake.seed({
    apiVersion: "node.k8s.io/v1",
    kind: "RuntimeClass",
    metadata: { name: "gvisor" },
    handler,
  });
  fake.seed({
    apiVersion: "node.k8s.io/v1",
    kind: "RuntimeClass",
    metadata: { name: "runc" },
    handler: "runc",
  });
  for (const [name, ip] of Object.entries(CLUSTER_IPS)) {
    fake.seed({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name, namespace: "kobe" },
      spec: { clusterIP: ip },
    });
  }
}

/** A real isolation gate whose RuntimeClass list comes from the fake cluster. */
export function gateFor(fake: FakeKube): IsolationGate {
  return createIsolationGate({
    runtimeClassName: "gvisor",
    listRuntimeClasses: async () => fake.all("RuntimeClass") as unknown as RuntimeClassLike[],
  });
}

/** Narrows away undefined in tests (instead of non-null assertions). */
export function must<T>(value: T | undefined | null, what = "value"): T {
  if (value === undefined || value === null) throw new Error(`expected ${what}`);
  return value;
}
