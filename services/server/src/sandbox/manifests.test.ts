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
      KOBE_SERVER_URL: "ws://server.kobe.internal",
      KOBE_MODEL_GATEWAY_URL: "http://model-gateway.kobe.internal:8080",
      KOBE_MCP_PROXY_URL: "http://mcp-proxy.kobe.internal",
      HTTPS_PROXY: "http://egress-proxy.kobe.internal",
      KOBE_BOOTSTRAP_TOKEN_FILE: "/var/run/secrets/kobe/bootstrap-token",
    });
  });

  it("meets Pod Security 'restricted' and the D12 sizing", async () => {
    const spec = sandboxPodSpec(await verified(), SETTINGS, ADDRESSES) as unknown as Pod & {
      containers: { resources: unknown }[];
    };
    expect(spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(must(spec.containers[0]).securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(must(spec.containers[0]).resources).toEqual({
      requests: { cpu: "500m", memory: "1Gi" },
      limits: { cpu: "2", memory: "4Gi" },
    });
    expect(spec.volumes).toContainEqual({ name: "tmp", emptyDir: { sizeLimit: "2Gi" } });
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
    expect(np.spec.podSelector).toEqual({});
    expect(np.spec.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(np.spec.ingress).toEqual([]);
  });

  it("allows egress only to the server, model gateway, MCP proxy and egress proxy pods", () => {
    expect(np.spec.egress).toHaveLength(4);
    for (const rule of np.spec.egress) {
      expect(rule.to).toHaveLength(1);
      expect(must(rule.to[0]).namespaceSelector).toEqual({
        matchLabels: { "kubernetes.io/metadata.name": "kobe" },
      });
      expect(rule.ports).toEqual([{ protocol: "TCP", port: 8080 }]);
    }
    const components = np.spec.egress.map(
      (r) =>
        (must(r.to[0]).podSelector as { matchLabels: Record<string, string> }).matchLabels[
          "app.kubernetes.io/component"
        ],
    );
    expect(components).toEqual(["server", "bifrost", "mcp-proxy", "egress-proxy"]);
    expect(JSON.stringify(np)).not.toMatch(/"port":53|ipBlock/);
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
