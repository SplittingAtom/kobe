import { AUDIT_EVENTS } from "@kobe/db";
import { describe, expect, it, vi } from "vitest";
import { IsolationRuntimeMissingError, type IsolationGate } from "../isolation/gate.js";
import { createFakeKube, simulateAgentSandbox, type FakeKube } from "../testing/fake-kube.js";
import {
  OTHER_TEAM,
  OTHER_USER,
  SETTINGS,
  TEAM,
  USER,
  gateFor,
  must,
  seedCluster,
} from "../testing/sandbox-fixtures.js";
import type { SandboxSettings } from "./config.js";
import {
  BOOTSTRAP_TOKEN_AUDIENCE,
  LABEL_CLAIM_UID,
  LABEL_TEAM_ID,
  LABEL_TEAM_NAMESPACE,
} from "./constants.js";
import type { TokenReviewResult } from "./kube.js";
import {
  SandboxAuthError,
  ADMISSION_PROBE_NAMESPACE,
  SandboxProvisioningError,
  TEAM_RECONVERGE_MS,
  createSandboxProvider,
  type SandboxAuditEvent,
  type SandboxProviderOptions,
} from "./provider.js";

const NS = "kobe-team-finance";

function setup(
  opts: {
    controller?: Parameters<typeof simulateAgentSandbox>[1] | false;
    settings?: SandboxSettings;
    gate?: Pick<IsolationGate, "require">;
    provider?: Partial<SandboxProviderOptions>;
  } = {},
) {
  const kube = createFakeKube();
  seedCluster(kube);
  if (opts.controller !== false) simulateAgentSandbox(kube, opts.controller || {});
  const gate = opts.gate ?? gateFor(kube);
  const provider = createSandboxProvider({
    kube,
    isolation: gate,
    settings: opts.settings ?? SETTINGS,
    sleep: async () => {},
    ...opts.provider,
  });
  return { kube, gate, provider };
}

const objectAt = (kube: FakeKube, kind: string, name: string, namespace?: string) =>
  kube.all(kind).find((o) => o.metadata.name === name && o.metadata.namespace === namespace);

describe("ensureSandbox: team namespace (D11)", () => {
  it("creates the team namespace with its team id and Pod Security 'baseline' (KOBE-71)", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    const ns = objectAt(kube, "Namespace", NS);
    expect(ns?.metadata.labels).toMatchObject({
      [LABEL_TEAM_ID]: TEAM.id,
      [LABEL_TEAM_NAMESPACE]: "true",
      "pod-security.kubernetes.io/enforce": "baseline",
    });
  });

  it("binds the server to the manager ClusterRole in that namespace only", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    const bindings = kube.all("RoleBinding");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      metadata: { namespace: NS },
      roleRef: { kind: "ClusterRole", name: SETTINGS.managerClusterRole },
      subjects: [{ kind: "ServiceAccount", name: "kobe-server", namespace: "kobe" }],
    });
  });

  it("applies the default-deny NetworkPolicy before anything that can start a pod", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    const writes = kube.calls.filter((c) => c.verb === "apply" || c.verb === "create");
    const at = (kind: string) => writes.findIndex((c) => c.kind === kind);
    expect(at("NetworkPolicy")).toBeGreaterThan(-1);
    for (const kind of ["SandboxTemplate", "SandboxWarmPool", "SandboxClaim"]) {
      expect(at("NetworkPolicy")).toBeLessThan(at(kind));
    }
  });

  it("puts a quota, container defaults, the sandbox ServiceAccount, template and warm pool there", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    expect(objectAt(kube, "ResourceQuota", "kobe-team-quota", NS)?.spec).toEqual({
      hard: SETTINGS.teamQuota,
    });
    expect(objectAt(kube, "LimitRange", "kobe-sandbox-defaults", NS)).toBeDefined();
    expect(objectAt(kube, "ServiceAccount", "kobe-sandbox", NS)).toMatchObject({
      automountServiceAccountToken: false,
    });
    const template = objectAt(kube, "SandboxTemplate", "kobe-sandbox", NS);
    expect(template?.spec).toMatchObject({
      networkPolicyManagement: "Unmanaged",
      podTemplate: {
        spec: {
          runtimeClassName: "gvisor",
          hostAliases: expect.arrayContaining([
            { ip: "10.43.0.10", hostnames: ["server.kobe.internal"] },
          ]),
        },
      },
    });
    expect(objectAt(kube, "SandboxWarmPool", "kobe-sandbox", NS)?.spec).toMatchObject({
      replicas: 1,
      sandboxTemplateRef: { name: "kobe-sandbox" },
    });
  });

  it("refuses a namespace that is labelled for another team (no volume reuse)", async () => {
    const { kube, provider } = setup();
    kube.seed({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: NS, labels: { [LABEL_TEAM_ID]: OTHER_TEAM.id } },
    });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(SandboxProvisioningError);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });

  it("refuses a pre-existing unlabelled namespace with the same name", async () => {
    const { kube, provider } = setup();
    kube.seed({ apiVersion: "v1", kind: "Namespace", metadata: { name: NS } });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/not labelled for team/);
  });

  it("retries while a fresh RoleBinding reaches the authorizer (403)", async () => {
    const { kube, provider } = setup();
    kube.failNext("apply", "NetworkPolicy", 403, 2);
    await expect(provider.ensureSandbox(TEAM, USER)).resolves.toMatchObject({ state: "running" });
  });

  it("names Rancher's namespace webhook and the chart value when Rancher refuses the namespace", async () => {
    const { kube, provider } = setup();
    kube.failNext(
      "apply",
      "Namespace",
      400,
      1,
      `Kubernetes API apply Namespace ${NS}: admission webhook ` +
        `"rancher.cattle.io.namespaces.create-non-kubesystem" denied the request: Unauthorized`,
    );
    const err = await provider.ensureSandbox(TEAM, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxProvisioningError);
    expect(String(err)).toMatch(/rancher\.cattle\.io\.namespaces/);
    expect(String(err)).toMatch(/rancher\.enabled=true/);
    expect(String(err)).toMatch(/updatepsa/);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });

  it("passes other namespace failures through unchanged", async () => {
    const { kube, provider } = setup();
    kube.failNext("apply", "Namespace", 500);
    const err = await provider.ensureSandbox(TEAM, USER).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SandboxProvisioningError);
    expect(String(err)).toMatch(/injected 500/);
  });

  it("gives up on a persistent 403 without creating any sandbox", async () => {
    const { kube, provider } = setup();
    kube.failNext("apply", "NetworkPolicy", 403, 100);
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/403/);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
    expect(kube.all("SandboxTemplate")).toHaveLength(0);
  });

  it("converges a team once per process, and retries after a failure", async () => {
    const { kube, provider } = setup();
    kube.failNext("apply", "ResourceQuota", 500);
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow();
    await provider.ensureSandbox(TEAM, USER);
    await provider.ensureSandbox(TEAM, OTHER_USER);
    const quotaApplies = kube.calls.filter((c) => c.verb === "apply" && c.kind === "ResourceQuota");
    expect(quotaApplies).toHaveLength(2);
  });

  it("re-converges a team after TEAM_RECONVERGE_MS (repairs a deleted NetworkPolicy)", async () => {
    let t = 0;
    const { kube, provider } = setup({ provider: { now: () => t } });
    await provider.ensureSandbox(TEAM, USER);
    await kube.delete({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      name: "kobe-sandbox-isolation",
      namespace: NS,
    });
    await provider.ensureSandbox(TEAM, USER);
    expect(objectAt(kube, "NetworkPolicy", "kobe-sandbox-isolation", NS)).toBeUndefined();
    t += TEAM_RECONVERGE_MS;
    await provider.ensureSandbox(TEAM, USER);
    expect(objectAt(kube, "NetworkPolicy", "kobe-sandbox-isolation", NS)).toBeDefined();
  });

  it("copies image pull Secrets into the team namespace for the kubelet", async () => {
    const settings = { ...SETTINGS, imagePullSecrets: ["ghcr-pull"] };
    const { kube, provider } = setup({ settings });
    kube.seed({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "ghcr-pull", namespace: "kobe", labels: { other: "x" } },
      type: "kubernetes.io/dockerconfigjson",
      data: { ".dockerconfigjson": "e30=" },
    });
    await provider.ensureSandbox(TEAM, USER);
    expect(objectAt(kube, "Secret", "ghcr-pull", NS)).toMatchObject({
      type: "kubernetes.io/dockerconfigjson",
      data: { ".dockerconfigjson": "e30=" },
      metadata: { labels: { "app.kubernetes.io/managed-by": "kobe-server" } },
    });
    const template = objectAt(kube, "SandboxTemplate", "kobe-sandbox", NS);
    expect(template?.spec).toMatchObject({
      podTemplate: { spec: { imagePullSecrets: [{ name: "ghcr-pull" }] } },
    });
  });

  it("fails clearly when a pull Secret or a Service ClusterIP is missing", async () => {
    const withSecret = setup({ settings: { ...SETTINGS, imagePullSecrets: ["missing"] } });
    await expect(withSecret.provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/missing/);
    const { kube, provider } = setup();
    kube.seed({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "kobe-bifrost", namespace: "kobe" },
      spec: { clusterIP: "None" },
    });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/no ClusterIP/);
  });
});

describe("ensureSandbox: one sandbox per (user, team) (D11)", () => {
  it("claims a sandbox whose claim UID is the sandbox id, and returns its pod", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    const claim = objectAt(kube, "SandboxClaim", `u-${USER}`, NS);
    expect(handle).toEqual({
      sandboxId: claim?.metadata.uid,
      namespace: NS,
      claimName: `u-${USER}`,
      sandboxName: `u-${USER}`,
      state: "running",
      podName: `u-${USER}`,
    });
  });

  it("returns the same sandbox on repeat calls and gives each user their own", async () => {
    const { kube, provider } = setup();
    const a = await provider.ensureSandbox(TEAM, USER);
    const again = await provider.ensureSandbox(TEAM, USER);
    const b = await provider.ensureSandbox(TEAM, OTHER_USER);
    expect(again.sandboxId).toBe(a.sandboxId);
    expect(b.sandboxId).not.toBe(a.sandboxId);
    expect(kube.calls.filter((c) => c.verb === "create" && c.kind === "SandboxClaim")).toHaveLength(
      2,
    );
  });

  it("puts the same user's sandboxes for two teams in two namespaces", async () => {
    const { provider } = setup();
    const a = await provider.ensureSandbox(TEAM, USER);
    const b = await provider.ensureSandbox(OTHER_TEAM, USER);
    expect([a.namespace, b.namespace]).toEqual(["kobe-team-finance", "kobe-team-marketing"]);
    expect(b.sandboxId).not.toBe(a.sandboxId);
  });

  it("uses the claim another replica created first (409)", async () => {
    const { kube, provider } = setup();
    const winner = createSandboxProvider({
      kube,
      isolation: gateFor(kube),
      settings: SETTINGS,
      sleep: async () => {},
    });
    const first = await winner.ensureSandbox(TEAM, USER);
    // This replica's first get misses the claim, then its create collides (409).
    const original = kube.get.bind(kube);
    let missed = false;
    kube.get = async (r) => {
      if (r.kind === "SandboxClaim" && !missed) {
        missed = true;
        return undefined;
      }
      return original(r);
    };
    const second = await provider.ensureSandbox(TEAM, USER);
    expect(second.sandboxId).toBe(first.sandboxId);
  });

  it("waits for the controller to bind a pod", async () => {
    const { provider } = setup({ controller: { delayGets: 3 } });
    await expect(provider.ensureSandbox(TEAM, USER)).resolves.toMatchObject({ state: "running" });
  });

  it("times out when no pod appears (quota or capacity)", async () => {
    let t = 0;
    const { provider } = setup({
      controller: { noPods: true },
      provider: { now: () => (t += 1000), podWaitTimeoutMs: 5000 },
    });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/has no pod after 5000 ms/);
  });

  it("reports a hibernated sandbox as suspended without waiting for a pod", async () => {
    const { kube, provider } = setup();
    const { sandboxName } = await provider.ensureSandbox(TEAM, USER);
    const sandbox = must(objectAt(kube, "Sandbox", sandboxName, NS));
    kube.seed({ ...sandbox, spec: { ...(sandbox.spec as object), operatingMode: "Suspended" } });
    await expect(provider.ensureSandbox(TEAM, USER)).resolves.toMatchObject({ state: "suspended" });
  });

  it("refuses a claim whose identity annotations name someone else", async () => {
    const { kube, provider } = setup({ controller: false });
    kube.seed({
      apiVersion: "extensions.agents.x-k8s.io/v1beta1",
      kind: "SandboxClaim",
      metadata: {
        name: `u-${USER}`,
        namespace: NS,
        annotations: { [LABEL_TEAM_ID]: OTHER_TEAM.id, "kobe.splittingatom.io/user-id": USER },
      },
      spec: {},
    });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/does not belong/);
  });

  it("validates team and user ids before touching the cluster", async () => {
    const { kube, provider } = setup();
    await expect(provider.ensureSandbox({ id: TEAM.id, slug: "Bad_Slug" }, USER)).rejects.toThrow(
      TypeError,
    );
    await expect(provider.ensureSandbox(TEAM, "../x")).rejects.toThrow(TypeError);
    expect(kube.calls).toHaveLength(0);
  });
});

describe("ensureSandbox: isolation (KOBE-9 binding requirements)", () => {
  it("runs a fresh isolation check before every sandbox creation", async () => {
    const kube = createFakeKube();
    seedCluster(kube);
    simulateAgentSandbox(kube);
    const gate = gateFor(kube);
    const require = vi.spyOn(gate, "require");
    const provider = createSandboxProvider({
      kube,
      isolation: gate,
      settings: SETTINGS,
      sleep: async () => {},
    });
    await provider.ensureSandbox(TEAM, USER);
    await provider.ensureSandbox(TEAM, OTHER_USER);
    expect(require).toHaveBeenCalledTimes(2);
  });

  it("creates nothing and returns isolation_runtime_missing (503) without gVisor", async () => {
    const kube = createFakeKube();
    seedCluster(kube, "runc");
    simulateAgentSandbox(kube);
    const provider = createSandboxProvider({
      kube,
      isolation: gateFor(kube),
      settings: SETTINGS,
      sleep: async () => {},
    });
    const err = await provider.ensureSandbox(TEAM, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IsolationRuntimeMissingError);
    expect((err as IsolationRuntimeMissingError).status).toBe(503);
    expect((err as IsolationRuntimeMissingError).toResponseBody().code).toBe(
      "isolation_runtime_missing",
    );
    expect(kube.calls.filter((c) => c.verb !== "get" && c.verb !== "list")).toEqual([]);
  });

  it("deletes a sandbox whose pod is not under the verified RuntimeClass", async () => {
    const { kube, provider } = setup({ controller: { podRuntimeClass: () => "runc" } });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(IsolationRuntimeMissingError);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
    expect(kube.all("Sandbox")).toHaveLength(0);
    expect(kube.all("Pod")).toHaveLength(0);
  });

  it("deletes a sandbox when the RuntimeClass handler changed after the check", async () => {
    const { kube, provider } = setup({ controller: { delayGets: 1 } });
    const original = kube.get.bind(kube);
    kube.get = async (r) => {
      const result = await original(r);
      // Swap the handler right after the pod shows up (between require() and the read-back).
      if (r.kind === "Pod" && result) {
        kube.seed({
          apiVersion: "node.k8s.io/v1",
          kind: "RuntimeClass",
          metadata: { name: "gvisor" },
          handler: "runc",
        });
      }
      return result;
    };
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/handler changed/);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });

  it("deletes an existing sandbox whose template predates a RuntimeClass change", async () => {
    const { kube, provider } = setup();
    const { sandboxName } = await provider.ensureSandbox(TEAM, USER);
    const sandbox = must(objectAt(kube, "Sandbox", sandboxName, NS));
    const spec = structuredClone(sandbox.spec) as {
      podTemplate: { spec: Record<string, unknown> };
    };
    spec.podTemplate.spec.runtimeClassName = "kata";
    kube.seed({ ...sandbox, spec });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/template uses "kata"/);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });
});

describe("identifyBootstrapToken", () => {
  const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";

  async function withSandbox() {
    const ctx = setup();
    const handle = await ctx.provider.ensureSandbox(TEAM, USER);
    const pod = must(objectAt(ctx.kube, "Pod", must(handle.podName), NS));
    const review = (over: Partial<TokenReviewResult> = {}): TokenReviewResult => ({
      authenticated: true,
      audiences: [BOOTSTRAP_TOKEN_AUDIENCE],
      username: `system:serviceaccount:${NS}:kobe-sandbox`,
      extra: {
        "authentication.kubernetes.io/pod-name": [pod.metadata.name],
        "authentication.kubernetes.io/pod-uid": [pod.metadata.uid as string],
      },
      ...over,
    });
    ctx.kube.tokens.set(TOKEN, review());
    return { ...ctx, handle, pod, review };
  }

  it("resolves a claimed sandbox pod to (sandbox, team, user)", async () => {
    const { provider, handle } = await withSandbox();
    await expect(provider.identifyBootstrapToken(TOKEN)).resolves.toEqual({
      state: "assigned",
      principal: { sandboxId: handle.sandboxId, teamId: TEAM.id, userId: USER },
      namespace: NS,
      podName: handle.podName,
    });
  });

  it("asks the TokenReview for the bootstrap audience only", async () => {
    const { kube, provider } = await withSandbox();
    const review = vi.spyOn(kube, "reviewToken");
    await provider.identifyBootstrapToken(TOKEN);
    expect(review).toHaveBeenCalledWith(TOKEN, [BOOTSTRAP_TOKEN_AUDIENCE]);
  });

  it.each([
    ["unauthenticated", { authenticated: false }],
    ["another audience", { audiences: ["https://kubernetes.default.svc"] }],
    ["another ServiceAccount", { username: `system:serviceaccount:${NS}:default` }],
    ["a non-team namespace", { username: "system:serviceaccount:kube-system:kobe-sandbox" }],
    ["a token not bound to a pod", { extra: {} }],
  ])("rejects %s", async (_, over) => {
    const { kube, provider, review } = await withSandbox();
    kube.tokens.set(TOKEN, review(over as Partial<TokenReviewResult>));
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(SandboxAuthError);
  });

  it("rejects malformed tokens without a TokenReview", async () => {
    const { kube, provider } = await withSandbox();
    const review = vi.spyOn(kube, "reviewToken");
    await expect(provider.identifyBootstrapToken("short")).rejects.toThrow(SandboxAuthError);
    await expect(provider.identifyBootstrapToken(`${TOKEN} x`)).rejects.toThrow(SandboxAuthError);
    expect(review).not.toHaveBeenCalled();
  });

  it("rejects a token of a deleted or replaced pod", async () => {
    const { kube, provider, review, pod } = await withSandbox();
    kube.tokens.set(
      TOKEN,
      review({
        extra: {
          "authentication.kubernetes.io/pod-name": [pod.metadata.name],
          "authentication.kubernetes.io/pod-uid": ["00000000-0000-4000-8000-000000000000"],
        },
      }),
    );
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(/is gone/);
  });

  it("reports an unclaimed warm-pool pod as unassigned", async () => {
    const { kube, provider, pod } = await withSandbox();
    const labels = Object.fromEntries(
      Object.entries(pod.metadata.labels ?? {}).filter(([k]) => k !== LABEL_CLAIM_UID),
    );
    kube.seed({ ...pod, metadata: { ...pod.metadata, labels } });
    await expect(provider.identifyBootstrapToken(TOKEN)).resolves.toMatchObject({
      state: "unassigned",
    });
  });

  it("does not trust a pod's claim label that does not match the claim", async () => {
    const { kube, provider, pod } = await withSandbox();
    kube.seed({
      ...pod,
      metadata: {
        ...pod.metadata,
        labels: {
          ...pod.metadata.labels,
          [LABEL_CLAIM_UID]: "00000000-0000-4000-8000-000000000000",
        },
      },
    });
    await expect(provider.identifyBootstrapToken(TOKEN)).resolves.toMatchObject({
      state: "unassigned",
    });
  });

  it("takes the team from the namespace, refusing a claim that names another team", async () => {
    const { kube, provider, handle } = await withSandbox();
    const claim = must(objectAt(kube, "SandboxClaim", handle.claimName, NS));
    kube.seed({
      ...claim,
      metadata: {
        ...claim.metadata,
        annotations: { ...claim.metadata.annotations, [LABEL_TEAM_ID]: OTHER_TEAM.id },
      },
    });
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(/identity mismatch/);
  });

  it("deletes a claimed sandbox whose pod is not under the verified runtime", async () => {
    const { kube, provider, pod } = await withSandbox();
    kube.seed({ ...pod, spec: { ...(pod.spec as object), runtimeClassName: "runc" } });
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(
      IsolationRuntimeMissingError,
    );
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });

  it("refuses a malformed user id annotation with 401, not an internal error", async () => {
    const { kube, provider, pod } = await withSandbox();
    kube.seed({
      ...pod,
      metadata: {
        ...pod.metadata,
        annotations: {
          ...pod.metadata.annotations,
          "kobe.splittingatom.io/user-id": "-".repeat(36),
        },
      },
    });
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(SandboxAuthError);
  });

  it("refuses a pod that predates a recreated RuntimeClass", async () => {
    const { kube, provider } = await withSandbox();
    recreateRuntimeClass(kube);
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(
      IsolationRuntimeMissingError,
    );
  });

  it("hands out nothing without isolation", async () => {
    const { kube, provider } = await withSandbox();
    kube.seed({
      apiVersion: "node.k8s.io/v1",
      kind: "RuntimeClass",
      metadata: { name: "gvisor" },
      handler: "runc",
    });
    await expect(provider.identifyBootstrapToken(TOKEN)).rejects.toThrow(
      IsolationRuntimeMissingError,
    );
  });
});

const recreateRuntimeClass = (kube: FakeKube, handler = "runsc") =>
  kube.seed({
    apiVersion: "node.k8s.io/v1",
    kind: "RuntimeClass",
    metadata: {
      name: "gvisor",
      uid: crypto.randomUUID(),
      creationTimestamp: "2030-01-01T00:00:00Z",
    },
    handler,
  });

describe("admission self-check (fail closed)", () => {
  it("dry-runs an out-of-prefix namespace once and provisions when the policy refuses it", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    await provider.ensureSandbox(OTHER_TEAM, USER);
    const probes = kube.calls.filter((c) => c.verb === "create" && c.kind === "Namespace");
    expect(probes).toEqual([
      {
        verb: "create",
        kind: "Namespace",
        name: ADMISSION_PROBE_NAMESPACE,
        labels: expect.any(Object),
      },
    ]);
  });

  it("refuses to provision anything when the admission policy is not in effect", async () => {
    const { kube, provider } = setup();
    kube.dryRun = (o) => o;
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(
      /admission policies are not in effect/,
    );
    expect(kube.all("Namespace")).toHaveLength(0);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });

  it("refuses when the dry run fails for any other reason (e.g. RBAC), and retries later", async () => {
    const { kube, provider } = setup();
    kube.dryRun = () => {
      throw new Error("namespaces is forbidden");
    };
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/forbidden/);
    delete kube.dryRun;
    await expect(provider.ensureSandbox(TEAM, USER)).resolves.toMatchObject({ state: "running" });
  });
});

describe("deleting unverified sandboxes", () => {
  it("retries a failed delete and also deletes the pod itself", async () => {
    const { kube, provider } = setup({ controller: { podRuntimeClass: () => "runc" } });
    kube.failNext("delete", "SandboxClaim", 500, 2);
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/was deleted/);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
    expect(kube.calls.filter((c) => c.verb === "delete" && c.kind === "Pod")).toHaveLength(1);
  });

  it("refuses a pod older than its RuntimeClass (class recreated, even with the same name)", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    recreateRuntimeClass(kube);
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(/recreated/);
    expect(kube.all("SandboxClaim")).toHaveLength(0);
  });
});

describe("reconcileIsolation", () => {
  async function twoSandboxes() {
    const ctx = setup({ provider: { runtimeClassName: "gvisor" } });
    const a = await ctx.provider.ensureSandbox(TEAM, USER);
    const b = await ctx.provider.ensureSandbox(OTHER_TEAM, USER);
    return { ...ctx, a, b };
  }

  it("leaves verified pods alone", async () => {
    const { kube, provider } = await twoSandboxes();
    await expect(provider.reconcileIsolation()).resolves.toEqual({ deleted: [] });
    expect(kube.all("Pod")).toHaveLength(2);
  });

  it("deletes a team pod under another runtime, with its claim", async () => {
    const { kube, provider, a } = await twoSandboxes();
    const pod = must(objectAt(kube, "Pod", must(a.podName), NS));
    kube.seed({ ...pod, spec: { ...(pod.spec as object), runtimeClassName: "runc" } });
    const result = await provider.reconcileIsolation();
    expect(result.deleted).toEqual([`${NS}/${a.podName}`]);
    expect(kube.all("SandboxClaim").map((c) => c.metadata.namespace)).toEqual([
      "kobe-team-marketing",
    ]);
  });

  it("deletes pods that predate a recreated RuntimeClass", async () => {
    const { kube, provider } = await twoSandboxes();
    recreateRuntimeClass(kube);
    expect((await provider.reconcileIsolation()).deleted).toHaveLength(2);
  });

  it("stops every team pod but keeps claims when isolation is definitively lost", async () => {
    const { kube, provider } = await twoSandboxes();
    recreateRuntimeClass(kube, "runc");
    const result = await provider.reconcileIsolation();
    expect(result).toMatchObject({ reason: expect.stringMatching(/no longer isolates/) });
    expect(result.deleted).toHaveLength(2);
    expect(kube.all("Pod")).toHaveLength(0);
    expect(kube.all("SandboxClaim")).toHaveLength(2);
  });

  it("changes nothing when isolation cannot be checked (API errors are not evidence)", async () => {
    const { kube, provider } = await twoSandboxes();
    const failing = createSandboxProvider({
      kube,
      settings: SETTINGS,
      runtimeClassName: "gvisor",
      sleep: async () => {},
      isolation: {
        require: async () => {
          throw new IsolationRuntimeMissingError("Kubernetes API timed out");
        },
      },
    });
    // The class itself still isolates: a transient failure, not a loss.
    await expect(failing.reconcileIsolation()).resolves.toEqual({ deleted: [] });
    kube.failNext("get", "RuntimeClass", 500);
    await expect(failing.reconcileIsolation()).rejects.toThrow(/500/);
    expect(kube.all("Pod")).toHaveLength(2);
    expect(provider).toBeDefined();
  });

  it("ignores pods outside team namespaces", async () => {
    const { kube, provider } = await twoSandboxes();
    kube.seed({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "x", namespace: "default" },
      spec: { runtimeClassName: "runc" },
    });
    expect((await provider.reconcileIsolation()).deleted).toEqual([]);
  });
});

describe("audit events (KOBE-15 taxonomy)", () => {
  function audited(opts: Parameters<typeof setup>[0] = {}) {
    const events: SandboxAuditEvent[] = [];
    const ctx = setup({
      ...opts,
      provider: { ...opts.provider, audit: (e) => void events.push(e) },
    });
    return { ...ctx, events };
  }
  const valid = (e: SandboxAuditEvent) =>
    expect(AUDIT_EVENTS[e.action].target.safeParse(e.target).success).toBe(true);

  it("records sandbox.created once per new claim, with an allowlisted target", async () => {
    const { provider, events } = audited();
    const { sandboxId } = await provider.ensureSandbox(TEAM, USER);
    await provider.ensureSandbox(TEAM, USER);
    expect(events).toEqual([
      { action: "sandbox.created", teamId: TEAM.id, target: { sandboxId, userId: USER } },
    ]);
    events.forEach(valid);
  });

  it("records sandbox.destroyed when an unverified sandbox is deleted", async () => {
    const { provider, events } = audited({ controller: { podRuntimeClass: () => "runc" } });
    await expect(provider.ensureSandbox(TEAM, USER)).rejects.toThrow(IsolationRuntimeMissingError);
    expect(events.map((e) => e.action)).toEqual(["sandbox.created", "sandbox.destroyed"]);
    expect(events[1]).toMatchObject({
      teamId: TEAM.id,
      target: { userId: USER, reason: "isolation_mismatch", pod: `u-${USER}` },
    });
    events.forEach(valid);
  });

  it("records isolation_lost for pods the reconciler stops", async () => {
    const { kube, provider, events } = audited({ provider: { runtimeClassName: "gvisor" } });
    await provider.ensureSandbox(TEAM, USER);
    recreateRuntimeClass(kube, "runc");
    await provider.reconcileIsolation();
    const destroyed = events.filter((e) => e.action === "sandbox.destroyed");
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toMatchObject({ teamId: TEAM.id, target: { reason: "isolation_lost" } });
    events.forEach(valid);
  });

  it("keeps working when recording fails", async () => {
    const { provider } = setup({
      provider: {
        audit: () => {
          throw new Error("audit down");
        },
      },
    });
    await expect(provider.ensureSandbox(TEAM, USER)).resolves.toMatchObject({ state: "running" });
  });
});

describe("isLive (sandbox wire liveness, KOBE-24)", () => {
  it("is true only for the current claim UID of that team and user", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    expect(await provider.isLive(TEAM, USER, handle.sandboxId)).toBe(true);
    expect(await provider.isLive(TEAM, USER, "00000000-0000-4000-8000-0000000000aa")).toBe(false);
    const other = "11111111-1111-4111-8111-111111111111";
    expect(await provider.isLive(TEAM, other, handle.sandboxId)).toBe(false);
    expect(await provider.isLive({ ...TEAM, id: other }, USER, handle.sandboxId)).toBe(false);
    const claim = kube.all("SandboxClaim")[0];
    if (!claim) throw new Error("no claim");
    kube.seed({
      ...claim,
      metadata: { ...claim.metadata, deletionTimestamp: new Date().toISOString() },
    });
    expect(await provider.isLive(TEAM, USER, handle.sandboxId)).toBe(false);
  });
});
