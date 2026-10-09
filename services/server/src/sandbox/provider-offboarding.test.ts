import { describe, expect, it } from "vitest";
import { createFakeKube, simulateAgentSandbox, type FakeKube } from "../testing/fake-kube.js";
import { SETTINGS, TEAM, USER, gateFor, seedCluster } from "../testing/sandbox-fixtures.js";
import { createSandboxProvider, workspacePvcName } from "./provider.js";

/** Offboarding (KOBE-28, D12): destroy the sandbox at once, keep its volume until deleted. */
const NS = "kobe-team-finance";
const PVC = (name: string) => ({
  apiVersion: "v1",
  kind: "PersistentVolumeClaim",
  name,
  namespace: NS,
});

function setup() {
  const kube = createFakeKube();
  seedCluster(kube);
  simulateAgentSandbox(kube, {});
  const provider = createSandboxProvider({
    kube,
    isolation: gateFor(kube),
    settings: SETTINGS,
    sleep: async () => undefined,
  });
  return { kube, provider };
}

/** agent-sandbox creates the PVC from the Sandbox's volumeClaimTemplate, owned by the Sandbox. */
function seedVolume(kube: FakeKube, sandboxName: string): string {
  const sandbox = kube.peek({
    apiVersion: "agents.x-k8s.io/v1beta1",
    kind: "Sandbox",
    name: sandboxName,
    namespace: NS,
  });
  const name = workspacePvcName(sandboxName);
  kube.seed({
    ...PVC(name),
    metadata: {
      name,
      namespace: NS,
      ownerReferences: [
        {
          apiVersion: "agents.x-k8s.io/v1beta1",
          kind: "Sandbox",
          name: sandboxName,
          uid: sandbox?.metadata.uid as string,
          controller: true,
        },
      ],
    },
  });
  return name;
}

describe("destroySandbox (D12)", () => {
  it("deletes the claim, Sandbox and pod at once but keeps the volume, detached from its owner", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    const pvc = seedVolume(kube, handle.sandboxName);

    const result = await provider.destroySandbox(TEAM, USER, { retainVolume: true });

    expect(result).toEqual({ sandboxId: handle.sandboxId, pvc });
    expect(kube.all("SandboxClaim")).toHaveLength(0);
    expect(kube.all("Sandbox")).toHaveLength(0);
    expect(kube.all("Pod")).toHaveLength(0);
    const volume = kube.peek(PVC(pvc));
    expect(volume).toBeDefined();
    expect(volume?.metadata.ownerReferences).toBeUndefined();
  });

  it("detaches the volume before deleting the claim (a failed detach loses nothing)", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    const pvc = seedVolume(kube, handle.sandboxName);
    kube.failNext("patch", "PersistentVolumeClaim", 500);

    await expect(provider.destroySandbox(TEAM, USER, { retainVolume: true })).rejects.toThrow();

    expect(kube.all("SandboxClaim")).toHaveLength(1);
    expect(kube.peek(PVC(pvc))?.metadata.ownerReferences).toHaveLength(1);
    // Retrying works.
    await provider.destroySandbox(TEAM, USER, { retainVolume: true });
    expect(kube.all("SandboxClaim")).toHaveLength(0);
    expect(kube.peek(PVC(pvc))).toBeDefined();
  });

  it("works on a hibernated sandbox and is idempotent once it is gone", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    const pvc = seedVolume(kube, handle.sandboxName);
    await provider.hibernateSandbox(TEAM, USER, handle.sandboxId);

    await provider.destroySandbox(TEAM, USER, { retainVolume: true });
    await expect(provider.destroySandbox(TEAM, USER, { retainVolume: true })).resolves.toEqual({});
    expect(kube.peek(PVC(pvc))).toBeDefined();
  });

  it("fails (and the caller retries) when the claim cannot be deleted", async () => {
    const { kube, provider } = setup();
    await provider.ensureSandbox(TEAM, USER);
    kube.failNext("delete", "SandboxClaim", 500, 10);
    await expect(provider.destroySandbox(TEAM, USER, { retainVolume: true })).rejects.toThrow(
      /could not be deleted/,
    );
  });

  it("does nothing for a user without a sandbox", async () => {
    const { kube, provider } = setup();
    await provider.ensureTeam(TEAM, await gateFor(kube).require());
    await expect(provider.destroySandbox(TEAM, USER, { retainVolume: true })).resolves.toEqual({});
  });
});

describe("deleteVolume", () => {
  it("deletes a retained volume and tolerates a missing one", async () => {
    const { kube, provider } = setup();
    const handle = await provider.ensureSandbox(TEAM, USER);
    const pvc = seedVolume(kube, handle.sandboxName);
    await provider.destroySandbox(TEAM, USER, { retainVolume: true });

    await provider.deleteVolume(TEAM, pvc);
    expect(kube.peek(PVC(pvc))).toBeUndefined();
    await expect(provider.deleteVolume(TEAM, pvc)).resolves.toBeUndefined();
  });

  it("refuses names that are not a workspace volume", async () => {
    const { provider } = setup();
    await expect(provider.deleteVolume(TEAM, "data-postgres-0")).rejects.toThrow(/workspace/);
  });
});
