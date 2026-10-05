import { describe, expect, it } from "vitest";
import { createFakeKube } from "../../testing/fake-kube.js";
import { KEYS, SETTINGS, TEAM, gateFor, seedCluster } from "../../testing/sandbox-fixtures.js";
import type { OrbitEvalSettings, SandboxSettings } from "../../sandbox/config.js";
import { evalNetworkPolicyManifest, networkPolicyManifest } from "../../sandbox/manifests.js";
import { evalConfigMapManifest, evalJobManifest, evalJobName, type EvalJobInput } from "./job.js";

const EVAL_ID = "4f9c2d5a-6b7e-4f90-8abc-4d5e6f708192";
const EVAL: OrbitEvalSettings = {
  image: "ghcr.io/splittingatom/kobe-orbit-eval:0.1.0",
  deadlineSeconds: 900,
  resources: {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "1", memory: "2Gi" },
  },
};
const SANDBOX: SandboxSettings = {
  ...SETTINGS,
  modelGatewayAccess: true,
  imagePullSecrets: ["ghcr-pull"],
  orbitEval: EVAL,
};
const TOKEN = "header.payload.signature-of-this-eval";

async function input(): Promise<EvalJobInput> {
  const kube = createFakeKube();
  seedCluster(kube);
  return {
    namespace: "kobe-team-finance",
    teamId: TEAM.id,
    evalId: EVAL_ID,
    isolation: await gateFor(kube).require(),
    sandbox: SANDBOX,
    eval: EVAL,
    gatewayAddress: "10.43.0.11",
    model: "anthropic/claude-smart",
    token: TOKEN,
  };
}

type Pod = {
  runtimeClassName: string;
  automountServiceAccountToken: boolean;
  hostNetwork: boolean;
  hostPID: boolean;
  hostIPC: boolean;
  restartPolicy: string;
  dnsPolicy: string;
  hostAliases: { ip: string; hostnames: string[] }[];
  securityContext: Record<string, unknown>;
  containers: {
    name: string;
    image: string;
    env: { name: string; value?: string; valueFrom?: unknown }[];
    envFrom?: unknown;
    resources: { requests: Record<string, string>; limits: Record<string, string> };
    securityContext: Record<string, unknown>;
    volumeMounts: { name: string; mountPath: string; readOnly?: boolean }[];
  }[];
  volumes: Record<string, unknown>[];
};
type Job = {
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    backoffLimit: number;
    activeDeadlineSeconds: number;
    ttlSecondsAfterFinished: number;
    template: { metadata: { labels: Record<string, string> }; spec: Pod };
  };
};

describe("Orbit eval Job manifest (KOBE-93)", () => {
  it("runs under the verified gVisor/Kata RuntimeClass, in the team namespace", async () => {
    const job = evalJobManifest(await input()) as unknown as Job;
    expect(job.metadata.namespace).toBe("kobe-team-finance");
    expect(job.metadata.name).toBe(`orbit-eval-${EVAL_ID}`);
    expect(job.spec.template.spec.runtimeClassName).toBe("gvisor");
  });

  it("is as isolated as a sandbox: restricted, non-root, no token, no host namespaces", async () => {
    const { spec } = evalJobManifest(await input()) as unknown as Job;
    const pod = spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect([pod.hostNetwork, pod.hostPID, pod.hostIPC]).toEqual([false, false, false]);
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    const [container] = pod.containers;
    expect(pod.containers).toHaveLength(1);
    expect(container?.name).not.toBe("agent");
    expect(container?.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ["ALL"] },
    });
    // The chart's admission policy refuses Secret volumes, hostPath and API-audience tokens.
    for (const volume of pod.volumes) {
      expect(Object.keys(volume).filter((k) => k !== "name")).toHaveLength(1);
      expect(volume).not.toHaveProperty("secret");
      expect(volume).not.toHaveProperty("hostPath");
      expect(volume).not.toHaveProperty("projected");
    }
    expect(container?.envFrom).toBeUndefined();
    for (const e of container?.env ?? []) expect(e.valueFrom).toBeUndefined();
  });

  it("is bounded: one attempt, a deadline, resource limits, a TTL", async () => {
    const { spec } = evalJobManifest(await input()) as unknown as Job;
    expect(spec.backoffLimit).toBe(0);
    expect(spec.activeDeadlineSeconds).toBe(900);
    expect(spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    const [container] = spec.template.spec.containers;
    expect(container?.resources.limits).toMatchObject({
      cpu: "1",
      memory: "2Gi",
      "ephemeral-storage": expect.any(String),
    });
    expect(container?.resources.requests).toMatchObject({ cpu: "250m", memory: "512Mi" });
  });

  it("reaches the model gateway only: no DNS, one host alias, the gateway env and nothing else", async () => {
    const { spec } = evalJobManifest(await input()) as unknown as Job;
    const pod = spec.template.spec;
    expect(pod.dnsPolicy).toBe("None");
    expect(pod.hostAliases).toEqual([
      { ip: "10.43.0.11", hostnames: ["model-gateway.kobe.internal"] },
    ]);
    const env = Object.fromEntries((pod.containers[0]?.env ?? []).map((e) => [e.name, e.value]));
    expect(env).toEqual({
      KOBE_MODEL_GATEWAY_URL: "http://model-gateway.kobe.internal:8080",
      KOBE_MODEL_SESSION_TOKEN: TOKEN,
      KOBE_EVAL_MODEL: "anthropic/claude-smart",
    });
    // Never a provider key or a proxy to the open internet.
    expect(JSON.stringify(pod)).not.toMatch(/API_KEY|PROXY/i);
  });

  it("mounts the exported YAML read-only from a ConfigMap, with writable output and tmp", async () => {
    const i = await input();
    const pod = (evalJobManifest(i) as unknown as Job).spec.template.spec;
    const mounts = Object.fromEntries(
      (pod.containers[0]?.volumeMounts ?? []).map((m) => [m.mountPath, m]),
    );
    expect(mounts["/input"]?.readOnly).toBe(true);
    expect(mounts["/output"]).toBeDefined();
    expect(mounts["/tmp"]).toBeDefined();
    expect(pod.volumes.find((v) => v.name === "input")).toEqual({
      name: "input",
      configMap: { name: evalJobName(EVAL_ID), defaultMode: 0o444 },
    });
    const map = evalConfigMapManifest({
      namespace: i.namespace,
      teamId: TEAM.id,
      evalId: EVAL_ID,
      orbitYaml: "name: x\n",
    });
    expect(map.data).toEqual({ "agent.yaml": "name: x\n" });
    expect(JSON.stringify(map)).not.toContain(TOKEN);
  });

  it("uses the pull secrets by name and labels the pod for the eval's NetworkPolicy", async () => {
    const { spec, metadata } = evalJobManifest(await input()) as unknown as Job;
    expect(spec.template.spec).toMatchObject({ imagePullSecrets: [{ name: "ghcr-pull" }] });
    expect(spec.template.metadata.labels["kobe.splittingatom.io/orbit-eval"]).toBe(EVAL_ID);
    expect(metadata.labels["kobe.splittingatom.io/team-id"]).toBe(TEAM.id);
    expect(KEYS["kobe.model-gateway"]).toBeTruthy();
  });

  it("refuses a malformed eval id", async () => {
    const base = await input();
    expect(() => evalJobManifest({ ...base, evalId: "../x" })).toThrow(TypeError);
  });
});

describe("eval NetworkPolicy", () => {
  const eval_ = evalNetworkPolicyManifest("kobe-team-finance", SANDBOX) as unknown as {
    spec: {
      podSelector: unknown;
      policyTypes: string[];
      ingress: unknown[];
      egress: {
        to: { podSelector: { matchLabels: Record<string, string> } }[];
        ports: unknown[];
      }[];
    };
  };

  it("selects eval pods, denies ingress and allows only the model gateway's pod port", () => {
    expect(eval_.spec.podSelector).toEqual({
      matchExpressions: [{ key: "kobe.splittingatom.io/orbit-eval", operator: "Exists" }],
    });
    expect(eval_.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(eval_.spec.ingress).toEqual([]);
    expect(eval_.spec.egress).toHaveLength(1);
    expect(eval_.spec.egress[0]?.to[0]?.podSelector.matchLabels).toEqual(
      SETTINGS.endpoints.modelGateway.podLabels,
    );
    expect(eval_.spec.egress[0]?.ports).toEqual([{ protocol: "TCP", port: 8080 }]);
  });

  it("is the only policy that applies to eval pods: the namespace-wide one leaves them out", () => {
    const general = networkPolicyManifest("kobe-team-finance", SANDBOX) as unknown as {
      spec: { podSelector: unknown };
    };
    expect(general.spec.podSelector).toEqual({
      matchExpressions: [{ key: "kobe.splittingatom.io/orbit-eval", operator: "DoesNotExist" }],
    });
  });
});
