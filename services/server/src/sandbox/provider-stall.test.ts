import { describe, expect, it } from "vitest";
import { createFakeKube, simulateAgentSandbox, type FakeKube } from "../testing/fake-kube.js";
import { SETTINGS, TEAM, USER, gateFor, must, seedCluster } from "../testing/sandbox-fixtures.js";
import { ANNOTATION_VOLUME_RETRY } from "./constants.js";
import { createSandboxProvider, workspacePvcName } from "./provider.js";

/** A sandbox not Ready within the wake timeout (KOBE-192), against the fake cluster. */
const NS = "kobe-team-finance";
const STRICT = "kobe-abc123-workspace-strict-local";
const READY = { phase: "Running", conditions: [{ type: "Ready", status: "True" }] };

async function setup(
  opts: { storageClass?: string; pvcPhase?: string; podStatus?: Record<string, unknown> } = {},
) {
  const kube = createFakeKube();
  seedCluster(kube);
  simulateAgentSandbox(kube);
  let clock = 0;
  const provider = createSandboxProvider({
    kube,
    isolation: gateFor(kube),
    settings: SETTINGS,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    podWaitTimeoutMs: 5_000,
  });
  const handle = await provider.ensureSandbox(TEAM, USER);
  const pod = must(
    kube.peek({ apiVersion: "v1", kind: "Pod", name: handle.sandboxName, namespace: NS }),
  );
  kube.seed({ ...pod, status: opts.podStatus ?? { phase: "Pending" } });
  seedPvc(kube, handle.sandboxName, opts.storageClass ?? STRICT, opts.pvcPhase ?? "Bound");
  return { kube, provider, handle };
}

const seedPvc = (kube: FakeKube, sandboxName: string, storageClassName: string, phase: string) =>
  kube.seed({
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: workspacePvcName(sandboxName), namespace: NS },
    spec: { storageClassName },
    status: { phase },
  });

const podEvent = (kube: FakeKube, pod: string, reason: string, message: string) =>
  kube.seed({
    apiVersion: "v1",
    kind: "Event",
    metadata: { name: `${pod}.${reason}`, namespace: NS },
    involvedObject: { kind: "Pod", name: pod },
    reason,
    message,
    type: "Warning",
    lastTimestamp: "2026-10-09T10:00:00Z",
  });
const attachFailure = (kube: FakeKube, pod: string) =>
  podEvent(kube, pod, "FailedAttachVolume", "LocalReplicaSchedulingFailure: insufficient storage");

const exists = (kube: FakeKube, kind: string, name: string) =>
  kube.peek({ apiVersion: "v1", kind, name, namespace: NS }) !== undefined;

describe("awaitReady", () => {
  it("returns at once for a Ready pod", async () => {
    const { provider } = await setup({ podStatus: READY });
    await expect(provider.awaitReady(TEAM, USER)).resolves.toEqual({ ready: true });
  });

  it("after the wake timeout reports the volume cause for admins", async () => {
    const { kube, provider, handle } = await setup();
    attachFailure(kube, handle.sandboxName);
    const outcome = await provider.awaitReady(TEAM, USER);
    expect(outcome).toMatchObject({
      ready: false,
      sandboxId: handle.sandboxId,
      stall: { cause: "volume_unschedulable", volumePhase: "Bound", neverRan: true },
    });
  });
});

describe("retryStalledVolume", () => {
  it("deletes the pod and the never-used strict-local volume once", async () => {
    const { kube, provider, handle } = await setup();
    attachFailure(kube, handle.sandboxName);
    await expect(provider.retryStalledVolume(TEAM, USER)).resolves.toBe("retried");
    expect(exists(kube, "Pod", handle.sandboxName)).toBe(false);
    expect(exists(kube, "PersistentVolumeClaim", workspacePvcName(handle.sandboxName))).toBe(false);
    const sandbox = must(
      kube.peek({
        apiVersion: "agents.x-k8s.io/v1beta1",
        kind: "Sandbox",
        name: handle.sandboxName,
        namespace: NS,
      }),
    );
    expect(sandbox.metadata.annotations?.[ANNOTATION_VOLUME_RETRY]).toBe("true");
  });

  it("never retries twice", async () => {
    const { kube, provider, handle } = await setup();
    attachFailure(kube, handle.sandboxName);
    await provider.retryStalledVolume(TEAM, USER);
    // The controller recreates the pod and the volume; they stall again.
    seedPvc(kube, handle.sandboxName, STRICT, "Bound");
    kube.seed({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: handle.sandboxName, namespace: NS },
      status: { phase: "Pending" },
    });
    await expect(provider.retryStalledVolume(TEAM, USER)).resolves.toBe("declined");
    expect(exists(kube, "PersistentVolumeClaim", workspacePvcName(handle.sandboxName))).toBe(true);
  });

  it("never deletes a volume whose container has run before", async () => {
    const { kube, provider, handle } = await setup({
      podStatus: {
        phase: "Pending",
        containerStatuses: [{ state: { waiting: {} }, lastState: { terminated: { exitCode: 1 } } }],
      },
    });
    attachFailure(kube, handle.sandboxName);
    await expect(provider.retryStalledVolume(TEAM, USER)).resolves.toBe("declined");
    expect(exists(kube, "PersistentVolumeClaim", workspacePvcName(handle.sandboxName))).toBe(true);
    expect(kube.calls.some((c) => c.verb === "delete")).toBe(false);
  });

  it("declines other storage classes and other causes", async () => {
    const other = await setup({ storageClass: "longhorn" });
    attachFailure(other.kube, other.handle.sandboxName);
    await expect(other.provider.retryStalledVolume(TEAM, USER)).resolves.toBe("declined");

    const pull = await setup();
    podEvent(pull.kube, pull.handle.sandboxName, "Failed", "ErrImagePull");
    await expect(pull.provider.retryStalledVolume(TEAM, USER)).resolves.toBe("declined");
    expect(pull.kube.calls.some((c) => c.verb === "delete")).toBe(false);
  });

  it("declines when the pod is Ready", async () => {
    const { kube, provider, handle } = await setup({ podStatus: READY });
    attachFailure(kube, handle.sandboxName);
    await expect(provider.retryStalledVolume(TEAM, USER)).resolves.toBe("declined");
  });
});
