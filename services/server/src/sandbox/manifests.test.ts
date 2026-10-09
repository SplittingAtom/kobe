import { describe, expect, it } from "vitest";
import { createFakeKube } from "../testing/fake-kube.js";
import { SETTINGS, TEAM, USER, gateFor, must, seedCluster } from "../testing/sandbox-fixtures.js";
import { BOOTSTRAP_TOKEN_AUDIENCE, SANDBOX_HOSTS } from "./constants.js";
import {
  claimName,
  networkPolicyManifest,
  sandboxClaimManifest,
  sandboxPodSpec,
  sandboxTemplateManifest,
  teamNamespaceName,
  warmPoolManifest,
} from "./manifests.js";

const ADDRESSES = {
  server: "10.43.0.10",
  modelGateway: "10.43.0.11",
  mcpProxy: "10.43.0.12",
  egressProxy: "10.43.0.13",
};

async function verified() {
  const kube = createFakeKube();
  seedCluster(kube);
  return gateFor(kube).require();
}

type Pod = {
  runtimeClassName: string;
  automountServiceAccountToken: boolean;
  dnsPolicy: string;
  containers: {
    env: { name: string; value?: string; valueFrom?: unknown }[];
    envFrom?: unknown;
    securityContext: Record<string, unknown>;
    volumeMounts: Record<string, unknown>[];
  }[];
  volumes: Record<string, unknown>[];
  securityContext: Record<string, unknown>;
};

describe("names", () => {
  it("names the team namespace kobe-team-<slug> and refuses invalid slugs", () => {
    expect(teamNamespaceName(TEAM)).toBe("kobe-team-finance");
    for (const slug of ["", "-a", "a-", "A", "a_b", "a".repeat(33), "../x"]) {
      expect(() => teamNamespaceName({ id: TEAM.id, slug })).toThrow(TypeError);
    }
  });

  it("derives one claim per user and refuses non-uuid user ids", () => {
    expect(claimName(USER)).toBe(`u-${USER}`);
    expect(() => claimName("admin")).toThrow(TypeError);
  });
});

describe("sandbox pod spec (D12, D13; secrets never enter sandboxes)", () => {
  it("takes the RuntimeClass from a VerifiedIsolation only", async () => {
    const isolation = await verified();
    const spec = sandboxPodSpec(isolation, SETTINGS, ADDRESSES) as unknown as Pod;
    expect(spec.runtimeClassName).toBe("gvisor");
    // @ts-expect-error a RuntimeClass name string is not a VerifiedIsolation (KOBE-9)
    sandboxPodSpec({ runtimeClassName: "gvisor", handler: "runsc" }, SETTINGS, ADDRESSES);
  });

  it("mounts no Secrets and no API token; its only credential is the bootstrap token", async () => {
    const spec = sandboxPodSpec(await verified(), SETTINGS, ADDRESSES) as unknown as Pod;
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(JSON.stringify(spec)).not.toMatch(/secretKeyRef|secretRef|"secret":/);
    const projected = spec.volumes.find((v) => "projected" in v) as {
      projected: { sources: { serviceAccountToken: { audience: string } }[] };
    };
    expect(projected.projected.sources).toEqual([
      {
        serviceAccountToken: expect.objectContaining({ audience: BOOTSTRAP_TOKEN_AUDIENCE }),
      },
    ]);
  });

  it("has no DNS; Kobe services resolve through /etc/hosts to their ClusterIPs", async () => {
    const spec = sandboxPodSpec(await verified(), SETTINGS, ADDRESSES) as unknown as Pod & {
      dnsConfig: { nameservers: string[] };
      hostAliases: { ip: string; hostnames: string[] }[];
    };
    expect(spec.dnsPolicy).toBe("None");
    expect(spec.dnsConfig.nameservers).toEqual(["127.0.0.1"]);
    expect(spec.hostAliases).toEqual([
      { ip: "10.43.0.10", hostnames: [SANDBOX_HOSTS.server] },
      { ip: "10.43.0.11", hostnames: [SANDBOX_HOSTS.modelGateway] },
      { ip: "10.43.0.12", hostnames: [SANDBOX_HOSTS.mcpProxy] },
      { ip: "10.43.0.13", hostnames: [SANDBOX_HOSTS.egressProxy] },
    ]);
    const env = Object.fromEntries(must(spec.containers[0]).env.map((e) => [e.name, e.value]));
    expect(env).toMatchObject({
      KOBE_SERVER_URL: "ws://server.kobe.internal:8081",
      KOBE_MODEL_GATEWAY_URL: "http://model-gateway.kobe.internal:8080",
      KOBE_MCP_PROXY_URL: "http://mcp-proxy.kobe.internal",
      // Proxy URLs always carry the port: curl (and git, through libcurl) assume 1080 otherwise.
      HTTPS_PROXY: "http://egress-proxy.kobe.internal:80",
      HTTP_PROXY: "http://egress-proxy.kobe.internal:80",
      https_proxy: "http://egress-proxy.kobe.internal:80",
      http_proxy: "http://egress-proxy.kobe.internal:80",
      KOBE_EGRESS_PROXY_URL: "http://egress-proxy.kobe.internal:80",
      KOBE_BOOTSTRAP_TOKEN_FILE: "/run/kobe-agent/bootstrap/bootstrap-token",
      KOBE_PI_RUNAS: "/opt/kobe/bin/kobe-runas",
      KOBE_PI_RUNTIME_DIR: "/run/kobe-pi",
      KOBE_SKILLS_DIR: "/run/kobe-skills",
    });
  });

  it("tells the agent how often to push its workspace (KOBE-27), 0 when sync is off", async () => {
    const isolation = await verified();
    const envOf = (settings: typeof SETTINGS) =>
      (sandboxPodSpec(isolation, settings, ADDRESSES) as unknown as Pod).containers[0]?.env;
    expect(envOf(SETTINGS)).toContainEqual({
      name: "KOBE_WORKSPACE_SYNC_INTERVAL_MS",
      value: "60000",
    });
    expect(
      envOf({ ...SETTINGS, workspaceSync: { ...SETTINGS.workspaceSync, enabled: false } }),
    ).toContainEqual({ name: "KOBE_WORKSPACE_SYNC_INTERVAL_MS", value: "0" });
  });

  it("tells the agent whether to run Pi's tools in the partner-uid executor (KOBE-167), off by default", async () => {
    const isolation = await verified();
    const envOf = (settings: typeof SETTINGS) =>
      (sandboxPodSpec(isolation, settings, ADDRESSES) as unknown as Pod).containers[0]?.env;
    expect(envOf(SETTINGS)).toContainEqual({ name: "KOBE_TOOL_EXECUTOR", value: "false" });
    expect(envOf({ ...SETTINGS, toolExecutor: { enabled: true } })).toContainEqual({
      name: "KOBE_TOOL_EXECUTOR",
      value: "true",
    });
  });

  it("never overrides the image's command (tini + hardened launcher, KOBE-23) or args", async () => {
    const spec = sandboxPodSpec(await verified(), SETTINGS, ADDRESSES) as unknown as {
      containers: Record<string, unknown>[];
      initContainers?: unknown;
    };
    expect(spec.containers).toHaveLength(1);
    expect(must(spec.containers[0])).not.toHaveProperty("command");
    expect(must(spec.containers[0])).not.toHaveProperty("args");
    expect(spec.initContainers).toBeUndefined();
    const template = sandboxTemplateManifest("ns", await verified(), SETTINGS, ADDRESSES);
    expect(JSON.stringify(template)).not.toMatch(/"command"|"args"/);
  });

  it("is 'restricted' but for SETUID/SETGID for Pi identities (KOBE-71), with the D12 sizing", async () => {
    const spec = sandboxPodSpec(await verified(), SETTINGS, ADDRESSES) as unknown as Pod & {
      containers: { resources: unknown }[];
    };
    expect(spec.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      // kobe-agent, the 16 Pi identities' groups (2000-2015), then their partner (tool) groups
      // (3000-3015, KOBE-166): Pi identity n pairs with n + 1000.
      supplementalGroups: [
        1001,
        ...Array.from({ length: 16 }, (_, i) => 2000 + i),
        ...Array.from({ length: 16 }, (_, i) => 3000 + i),
      ],
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(must(spec.containers[0]).securityContext).toEqual({
      allowPrivilegeEscalation: true,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"], add: ["SETUID", "SETGID"] },
    });
    // The bootstrap token sits under the image's agent-only directory.
    expect(must(spec.containers[0]).volumeMounts).toContainEqual({
      name: "kobe-bootstrap",
      mountPath: "/run/kobe-agent/bootstrap",
      readOnly: true,
    });
    expect(must(spec.containers[0]).resources).toEqual({
      requests: { cpu: "500m", memory: "1Gi", "ephemeral-storage": "1Gi" },
      limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "4Gi" },
    });
    expect(spec.volumes).toContainEqual({ name: "tmp", emptyDir: { sizeLimit: "2Gi" } });
    // Pi runtime dirs on a sticky (memory-backed) volume no Pi identity can rename in (KOBE-71).
    expect(spec.volumes).toContainEqual({
      name: "pi-runtime",
      emptyDir: { medium: "Memory", sizeLimit: "64Mi" },
    });
    expect(must(spec.containers[0]).volumeMounts).toContainEqual({
      name: "pi-runtime",
      mountPath: "/run/kobe-pi",
    });
    // Effective skills (KOBE-82) on a sticky memory volume of their own, the agent's to write.
    expect(spec.volumes).toContainEqual({
      name: "pi-skills",
      emptyDir: { medium: "Memory", sizeLimit: "128Mi" },
    });
    expect(must(spec.containers[0]).volumeMounts).toContainEqual({
      name: "pi-skills",
      mountPath: "/run/kobe-skills",
    });
  });
});

describe("team NetworkPolicy (D11, D28)", () => {
  const np = networkPolicyManifest("kobe-team-finance", SETTINGS) as unknown as {
    spec: {
      podSelector: object;
      policyTypes: string[];
      ingress: unknown[];
      egress: { to: { namespaceSelector: unknown; podSelector: unknown }[]; ports: unknown[] }[];
    };
  };

  it("denies all ingress to every pod in the namespace", () => {
    // Every pod but Orbit eval pods, which have their own narrower policy (KOBE-93).
    expect(np.spec.podSelector).toEqual({
      matchExpressions: [{ key: "kobe.splittingatom.io/orbit-eval", operator: "DoesNotExist" }],
    });
    expect(np.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(np.spec.ingress).toEqual([]);
  });

  const egressOf = (policy: typeof np) =>
    policy.spec.egress.map((rule) => {
      expect(rule.to).toHaveLength(1);
      expect(must(rule.to[0]).namespaceSelector).toEqual({
        matchLabels: { "kubernetes.io/metadata.name": "kobe" },
      });
      const labels = (must(rule.to[0]).podSelector as { matchLabels: Record<string, string> })
        .matchLabels;
      return [labels["app.kubernetes.io/component"], rule.ports];
    });

  it("allows egress only to the server's sandbox port and the two proxies by default", () => {
    expect(egressOf(np)).toEqual([
      ["server", [{ protocol: "TCP", port: 8081 }]],
      ["mcp-proxy", [{ protocol: "TCP", port: 8080 }]],
      ["egress-proxy", [{ protocol: "TCP", port: 8080 }]],
    ]);
    expect(JSON.stringify(np)).not.toMatch(/"port":53|ipBlock|bifrost/);
  });

  it("adds the model gateway only when modelGatewayAccess is on (KOBE-40/41)", () => {
    const open = networkPolicyManifest("kobe-team-finance", {
      ...SETTINGS,
      modelGatewayAccess: true,
    }) as unknown as typeof np;
    expect(egressOf(open).map(([c]) => c)).toEqual([
      "server",
      "bifrost",
      "mcp-proxy",
      "egress-proxy",
    ]);
  });
});

describe("template, warm pool and claim", () => {
  it("keeps the controller's internet-egress NetworkPolicy out (Unmanaged)", async () => {
    const t = sandboxTemplateManifest("ns", await verified(), SETTINGS, ADDRESSES);
    expect(t.spec).toMatchObject({
      networkPolicyManagement: "Unmanaged",
      envVarsInjectionPolicy: "Disallowed",
      volumeClaimTemplatesPolicy: "Disallowed",
      service: false,
      volumeClaimTemplates: [
        {
          metadata: { name: "workspace" },
          spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "10Gi" } } },
        },
      ],
    });
    const withClass = sandboxTemplateManifest(
      "ns",
      await verified(),
      { ...SETTINGS, workspace: { size: "5Gi", storageClass: "longhorn" } },
      ADDRESSES,
    );
    expect(withClass.spec).toMatchObject({
      volumeClaimTemplates: [{ spec: { storageClassName: "longhorn" } }],
    });
  });

  it("sizes the per-namespace warm pool from settings", () => {
    expect(warmPoolManifest("ns", SETTINGS).spec).toEqual({
      replicas: 1,
      sandboxTemplateRef: { name: "kobe-sandbox" },
      updateStrategy: { type: "Recreate" },
    });
  });

  it("claims carry identity metadata only, so warm-pool adoption stays possible", () => {
    const claim = sandboxClaimManifest("kobe-team-finance", TEAM, USER);
    expect(claim.spec).toEqual({
      warmPoolRef: { name: "kobe-sandbox" },
      additionalPodMetadata: {
        annotations: {
          "kobe.splittingatom.io/team-id": TEAM.id,
          "kobe.splittingatom.io/user-id": USER,
        },
      },
    });
  });
});
