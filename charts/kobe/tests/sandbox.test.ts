import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { ISOLATION_HANDLER } from "../../../services/server/src/isolation/runtime-class.js";
import { loadSandboxConfig } from "../../../services/server/src/sandbox/config.js";
import {
  BOOTSTRAP_TOKEN_AUDIENCE,
  LABEL_TEAM_NAMESPACE,
  TEAM_NAMESPACE_PREFIX,
} from "../../../services/server/src/sandbox/constants.js";

// Render tests for the sandbox provider's chart pieces (KOBE-22): server config, RBAC, admission
// policies, session keys.

const CHART_DIR = fileURLToPath(new URL("..", import.meta.url));
const HELM = process.env.HELM_BIN ?? "helm";
const BASE: Record<string, string> = {
  "ingress.host": "kobe.example.com",
  "postgres.external.existingSecret": "kobe-db",
  "s3.endpoint": "https://s3.example.com",
  "s3.bucket": "kobe",
  "s3.existingSecret": "kobe-s3",
  "smtp.host": "smtp.example.com",
  "smtp.from": "Kobe <kobe@example.com>",
  "global.allowGeneratedSecretsOffline": "true",
};

type Manifest = { kind: string; metadata: { name: string; namespace?: string }; [k: string]: any };

function helm(values: Record<string, string>, extra: string[] = []): string {
  const args = Object.entries({ ...BASE, ...values }).flatMap(([k, v]) => ["--set", `${k}=${v}`]);
  return execFileSync(HELM, ["template", "kobe", CHART_DIR, "-n", "kobe", ...args, ...extra], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function render(values: Record<string, string> = {}, extra: string[] = []): Manifest[] {
  return parseAllDocuments(helm(values, extra))
    .map((d) => d.toJSON() as Manifest | null)
    .filter((m): m is Manifest => m !== null);
}

function renderError(values: Record<string, string>): string {
  try {
    helm(values);
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
  throw new Error("expected helm template to fail");
}

const find = (ms: Manifest[], kind: string, name: string) =>
  ms.find((m) => m.kind === kind && m.metadata.name === name);
const byKind = (ms: Manifest[], kind: string) => ms.filter((m) => m.kind === kind);
const container = (ms: Manifest[], deployment: string) =>
  find(ms, "Deployment", deployment)?.spec.template.spec.containers[0];
const envOf = (ms: Manifest[], deployment: string): { name: string; value?: string }[] =>
  container(ms, deployment)?.env ?? [];
const sandboxConfig = (ms: Manifest[]) =>
  JSON.parse(envOf(ms, "kobe-server").find((e) => e.name === "KOBE_SANDBOX_CONFIG")?.value ?? "{}");

describe("server sandbox configuration", () => {
  const ms = render();

  it("is valid for the server's config schema (with keys as the Secret provides them)", () => {
    const keys = {
      KOBE_SESSION_KEY_SANDBOX_WIRE: "a".repeat(48),
      KOBE_SESSION_KEY_MODEL_GATEWAY: "b".repeat(48),
      KOBE_SESSION_KEY_MCP_PROXY: "c".repeat(48),
      KOBE_SESSION_KEY_EGRESS_PROXY: "d".repeat(48),
    };
    const config = loadSandboxConfig({
      KOBE_SANDBOX_CONFIG: JSON.stringify(sandboxConfig(ms)),
      ...keys,
    });
    expect(config?.settings).toMatchObject({
      image: "ghcr.io/splittingatom/kobe-sandbox:0.1.0",
      releaseNamespace: "kobe",
      serverServiceAccount: "kobe-server",
      resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "2", memory: "4Gi" } },
      workspace: { size: "10Gi", storageClass: "" },
      teamQuota: { "requests.cpu": "20", "requests.memory": "40Gi" },
      warmPool: { replicasPerTeam: 1 },
    });
  });

  it("points sandboxes at the release's server, Bifrost, MCP proxy and egress proxy", () => {
    const { endpoints } = sandboxConfig(ms);
    for (const [key, component] of [
      ["server", "server"],
      ["modelGateway", "bifrost"],
      ["mcpProxy", "mcp-proxy"],
      ["egressProxy", "egress-proxy"],
    ] as const) {
      expect(find(ms, "Service", endpoints[key].service), key).toBeDefined();
      expect(endpoints[key].podLabels).toEqual({
        "app.kubernetes.io/name": "kobe",
        "app.kubernetes.io/instance": "kobe",
        "app.kubernetes.io/component": component,
      });
      const deployment = find(ms, "Deployment", `kobe-${component}`);
      expect(deployment?.spec.selector.matchLabels).toEqual(endpoints[key].podLabels);
      const ports = container(ms, `kobe-${component}`)?.ports as { containerPort: number }[];
      expect(ports.map((p) => p.containerPort)).toContain(endpoints[key].targetPort);
      const svcPorts = find(ms, "Service", endpoints[key].service)?.spec.ports as {
        port: number;
      }[];
      expect(svcPorts.map((p) => p.port)).toContain(endpoints[key].port);
    }
  });

  it("serves sandboxes on a separate server port that the ingress never routes to", () => {
    const { server } = sandboxConfig(ms).endpoints;
    expect(server).toMatchObject({ port: 8081, targetPort: 8081 });
    const ingress = find(ms, "Ingress", "kobe");
    for (const path of ingress?.spec.rules[0].http.paths ?? []) {
      expect(path.backend.service.port).toEqual({ name: "http" });
    }
  });

  it("keeps the model gateway closed to sandboxes by default", () => {
    expect(sandboxConfig(ms).modelGatewayAccess).toBe(false);
    expect(sandboxConfig(render({ "sandbox.modelGatewayAccess": "true" })).modelGatewayAccess).toBe(
      true,
    );
  });

  it("caps limits, pods, volumes and ephemeral storage per team, not only requests", () => {
    expect(sandboxConfig(ms).teamQuota).toEqual({
      "requests.cpu": "20",
      "requests.memory": "40Gi",
      "limits.cpu": "40",
      "limits.memory": "80Gi",
      "requests.ephemeral-storage": "40Gi",
      "limits.ephemeral-storage": "160Gi",
      "requests.storage": "500Gi",
      persistentvolumeclaims: "50",
      pods: "50",
    });
    expect(sandboxConfig(ms).ephemeralStorage).toEqual({ request: "1Gi", limit: "4Gi" });
  });

  it("names the manager ClusterRole the server binds in team namespaces", () => {
    expect(find(ms, "ClusterRole", sandboxConfig(ms).managerClusterRole)).toBeDefined();
  });

  it("propagates overrides and pull secrets", () => {
    const custom = sandboxConfig(
      render({
        "sandbox.warmPool.replicasPerTeam": "0",
        "sandbox.workspace.storageClass": "longhorn",
        "sandbox.teamQuota.requests\\.cpu": "8",
        "sandbox.resources.limits.cpu": "4",
        "global.imagePullSecrets[0].name": "ghcr-pull",
      }),
    );
    expect(custom).toMatchObject({
      warmPool: { replicasPerTeam: 0 },
      workspace: { storageClass: "longhorn" },
      teamQuota: { "requests.cpu": "8" },
      resources: { limits: { cpu: "4" } },
      imagePullSecrets: ["ghcr-pull"],
    });
  });

  it("defaults the sandbox key so `helm upgrade --reuse-values` keeps working", () => {
    expect(sandboxConfig(render({ sandbox: "null" })).warmPool).toEqual({ replicasPerTeam: 1 });
  });

  it("gives the session keys to the server only", () => {
    const names = (d: string) =>
      envOf(ms, d)
        .map((e) => e.name)
        .filter((n) => n.startsWith("KOBE_SESSION_KEY_"));
    expect(names("kobe-server").sort()).toEqual([
      "KOBE_SESSION_KEY_EGRESS_PROXY",
      "KOBE_SESSION_KEY_MCP_PROXY",
      "KOBE_SESSION_KEY_MODEL_GATEWAY",
      "KOBE_SESSION_KEY_SANDBOX_WIRE",
    ]);
    for (const d of ["kobe-scheduler", "kobe-web", "kobe-mcp-proxy", "kobe-egress-proxy"]) {
      expect(names(d), d).toEqual([]);
    }
  });
});

describe("release-side NetworkPolicy", () => {
  it("admits team namespaces to web, server and scheduler only on the sandbox port", () => {
    const np = find(render(), "NetworkPolicy", "kobe-not-from-sandboxes");
    expect(np?.spec.podSelector.matchExpressions).toEqual([
      {
        key: "app.kubernetes.io/component",
        operator: "In",
        values: ["web", "server", "scheduler"],
      },
    ]);
    expect(np?.spec.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: {
              matchExpressions: [
                { key: "kobe.splittingatom.io/team-namespace", operator: "DoesNotExist" },
              ],
            },
          },
        ],
      },
      {
        from: [
          {
            namespaceSelector: { matchLabels: { "kobe.splittingatom.io/team-namespace": "true" } },
          },
        ],
        ports: [{ protocol: "TCP", port: 8081 }],
      },
    ]);
  });
});

describe("session keys Secret", () => {
  it("generates four distinct keys and keeps the Secret on uninstall", () => {
    const secret = find(render(), "Secret", "kobe-sandbox-session-keys");
    expect(secret?.metadata.annotations["helm.sh/resource-policy"]).toBe("keep");
    const values = Object.values(secret?.stringData ?? {}) as string[];
    expect(Object.keys(secret?.stringData ?? {}).sort()).toEqual([
      "egress-proxy",
      "mcp-proxy",
      "model-gateway",
      "sandbox-wire",
    ]);
    expect(new Set(values).size).toBe(4);
    for (const v of values) expect(v.length).toBeGreaterThanOrEqual(32);
  });

  it("uses a pre-created Secret instead (GitOps-safe)", () => {
    const ms = render({ "sandbox.sessionKeysSecret": "my-keys" });
    expect(find(ms, "Secret", "kobe-sandbox-session-keys")).toBeUndefined();
    expect(container(ms, "kobe-server")?.env).toContainEqual({
      name: "KOBE_SESSION_KEY_SANDBOX_WIRE",
      valueFrom: { secretKeyRef: { name: "my-keys", key: "sandbox-wire" } },
    });
  });

  it("refuses to generate them in an offline render", () => {
    expect(
      renderError({ "global.allowGeneratedSecretsOffline": "false", "auth.existingSecret": "a" }),
    ).toMatch(/sandbox\.sessionKeysSecret/);
  });
});

describe("sandbox RBAC (least privilege; D11)", () => {
  const ms = render({ "global.imagePullSecrets[0].name": "ghcr-pull" });
  const manager = sandboxConfig(ms).managerClusterRole as string;
  const rules = (
    kind: string,
    name: string,
  ): { resources: string[]; verbs: string[]; resourceNames?: string[]; apiGroups: string[] }[] =>
    find(ms, kind, name)?.rules ?? [];
  const orchestrator = byKind(ms, "ClusterRole").find((r) =>
    r.metadata.name.endsWith("-sandbox-orchestrator"),
  )?.metadata.name as string;

  it("never grants wildcards, Secret reads, pod creation, exec or escalate", () => {
    for (const [kind, name] of [
      ["ClusterRole", manager],
      ["ClusterRole", orchestrator],
    ] as const) {
      for (const rule of rules(kind, name)) {
        expect(rule.verbs, name).not.toContain("*");
        expect(rule.resources, name).not.toContain("*");
        expect(rule.verbs, name).not.toContain("escalate");
        expect(rule.verbs, name).not.toContain("impersonate");
        if (rule.resources.includes("secrets")) {
          expect(rule.verbs, name).not.toEqual(expect.arrayContaining(["get"]));
          expect(rule.verbs, name).not.toContain("list");
        }
        if (rule.resources.includes("pods")) {
          expect(rule.verbs, name).not.toContain("create");
          expect(rule.verbs, name).not.toContain("patch");
        }
        expect(rule.resources.some((r) => r.includes("/exec") || r.includes("/attach"))).toBe(
          false,
        );
      }
    }
  });

  it("lets the server bind only the manager role, and never delete namespaces", () => {
    const bind = rules("ClusterRole", orchestrator).find((r) => r.verbs.includes("bind"));
    expect(bind).toEqual({
      apiGroups: ["rbac.authorization.k8s.io"],
      resources: ["clusterroles"],
      verbs: ["bind"],
      resourceNames: [manager],
    });
    const ns = rules("ClusterRole", orchestrator).find((r) => r.resources.includes("namespaces"));
    expect(ns?.verbs).not.toContain("delete");
    expect(rules("ClusterRole", orchestrator)).toContainEqual({
      apiGroups: ["authentication.k8s.io"],
      resources: ["tokenreviews"],
      verbs: ["create"],
    });
  });

  it("binds cluster-wide verbs to the server ServiceAccount only; the manager role is not bound cluster-wide", () => {
    const binding = find(ms, "ClusterRoleBinding", orchestrator);
    expect(binding?.subjects).toEqual([
      { kind: "ServiceAccount", name: "kobe-server", namespace: "kobe" },
    ]);
    expect(byKind(ms, "ClusterRoleBinding").some((b) => b.roleRef.name === manager)).toBe(false);
  });

  it("reads only the four Services and the pull Secrets, by name, in the release namespace", () => {
    expect(rules("Role", "kobe-sandbox-orchestrator")).toEqual([
      {
        apiGroups: [""],
        resources: ["services"],
        verbs: ["get"],
        resourceNames: ["kobe-server", "kobe-bifrost", "kobe-mcp-proxy", "kobe-egress-proxy"],
      },
      { apiGroups: [""], resources: ["secrets"], verbs: ["get"], resourceNames: ["ghcr-pull"] },
    ]);
  });
});

describe("sandbox admission policies (KOBE-9 binding requirement 3)", () => {
  const ms = render({ "isolation.runtimeClassName": "kata-qemu" });
  const policies = byKind(ms, "ValidatingAdmissionPolicy");
  const bindings = byKind(ms, "ValidatingAdmissionPolicyBinding");
  const policy = (suffix: string) => policies.find((p) => p.metadata.name.endsWith(suffix));
  const expressions = (suffix: string) =>
    JSON.stringify(
      policy(suffix)?.spec.validations.map((v: { expression: string }) => v.expression),
    );

  it("binds every policy with Deny and fails closed", () => {
    expect(policies).toHaveLength(4);
    for (const p of policies) {
      expect(p.spec.failurePolicy).toBe("Fail");
      const binding = bindings.find((b) => b.spec.policyName === p.metadata.name);
      expect(binding?.spec.validationActions).toEqual(["Deny"]);
    }
  });

  it("pins pods and sandbox specs to the configured RuntimeClass and an isolating handler", () => {
    for (const suffix of ["-sandbox-pods", "-sandbox-specs"]) {
      const p = policy(suffix);
      expect(p?.spec.paramKind).toEqual({ apiVersion: "node.k8s.io/v1", kind: "RuntimeClass" });
      const binding = bindings.find((b) => b.spec.policyName === p?.metadata.name);
      expect(binding?.spec.paramRef).toEqual({
        name: "kata-qemu",
        parameterNotFoundAction: "Deny",
      });
      expect(p?.spec.matchConditions).toEqual([
        {
          name: "team-namespace",
          expression: `request.namespace.startsWith('${TEAM_NAMESPACE_PREFIX}')`,
        },
      ]);
      expect(expressions(suffix)).toContain(
        `params.handler.matches('${ISOLATION_HANDLER.source}')`,
      );
    }
    expect(policy("-sandbox-pods")?.spec.matchConstraints.resourceRules).toEqual([
      { apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["pods"] },
    ]);
  });

  it("keeps credentials out of sandbox pods", () => {
    const e = expressions("-sandbox-pods");
    for (const fragment of [
      "automountServiceAccountToken",
      "has(v.secret)",
      "has(v.hostPath)",
      "secretKeyRef",
      "secretRef",
      "hostNetwork",
      `'${BOOTSTRAP_TOKEN_AUDIENCE}'`,
    ]) {
      expect(e).toContain(fragment);
    }
  });

  it("confines the server's namespace and RoleBinding writes to labelled kobe-team-* namespaces", () => {
    const p = policy("-server-scope");
    expect(p?.spec.matchConditions).toEqual([
      {
        name: "kobe-server",
        expression: "request.userInfo.username == 'system:serviceaccount:kobe:kobe-server'",
      },
    ]);
    const e = expressions("-server-scope");
    expect(e).toContain(`startsWith('${TEAM_NAMESPACE_PREFIX}')`);
    expect(e).toContain(LABEL_TEAM_NAMESPACE);
    expect(e).toContain("restricted");
    expect(e).toContain(sandboxConfig(ms).managerClusterRole);
    expect(e).toContain("oldLabels[?'kobe.splittingatom.io/team-id']");
  });

  it("requires Unmanaged templates and leaves team NetworkPolicies to the server", () => {
    expect(expressions("-sandbox-specs")).toContain("Unmanaged");
    expect(expressions("-sandbox-netpol")).toContain("system:serviceaccount:kobe:kobe-server");
  });
});

describe("values.schema.json: sandbox", () => {
  it("rejects unknown keys and out-of-range warm pools", () => {
    expect(renderError({ "sandbox.privileged": "true" })).toMatch(/privileged|additional/i);
    expect(renderError({ "sandbox.warmPool.replicasPerTeam": "50" })).toMatch(
      /replicasPerTeam|maximum/,
    );
    expect(renderError({ "sandbox.tmpSize": "lots" })).toMatch(/tmpSize|pattern|oneOf/i);
  });
});
