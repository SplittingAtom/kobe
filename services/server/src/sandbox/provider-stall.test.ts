import { describe, expect, it } from "vitest";
import { createFakeKube, simulateAgentSandbox, type FakeKube } from "../testing/fake-kube.js";
import { SETTINGS, TEAM, USER, gateFor, must, seedCluster } from "../testing/sandbox-fixtures.js";
import { createSandboxProvider, workspacePvcName } from "./provider.js";

/** A woken sandbox that is slow or stuck (KOBE-192), against the fake cluster and a fake clock. */
const NS = "kobe-team-finance";
const READY = { phase: "Running", conditions: [{ type: "Ready", status: "True" }] };
const T0 = Date.parse("2026-10-09T10:00:00Z");

async function setup(readyTimeoutMs = 90_000) {
  const kube = createFakeKube();
  seedCluster(kube);
  simulateAgentSandbox(kube);
  const clock = { ms: 0 };
  const ticks: ((ms: number) => void)[] = [];
  const provider = createSandboxProvider({
    kube,
    isolation: gateFor(kube),
    settings: SETTINGS,
    now: () => T0 + clock.ms,
    sleep: async (ms) => {
      clock.ms += ms;
      ticks.forEach((t) => t(clock.ms));
    },
    readyTimeoutMs,
  });
  const handle = await provider.ensureSandbox(TEAM, USER);
  const podRef = { apiVersion: "v1", kind: "Pod", name: handle.sandboxName, namespace: NS };
  const pod = must(kube.peek(podRef));
  const setStatus = (status: Record<string, unknown>) =>
    kube.seed({ ...must(kube.peek(podRef)), status });
  setStatus({ phase: "Pending" });
  const pvc = kube.seed({
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: workspacePvcName(handle.sandboxName), namespace: NS },
    spec: { storageClassName: "kobe-abc123-workspace-strict-local" },
    status: { phase: "Bound" },
  });
  const podEvent = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
    kube.seed({
      apiVersion: "v1",
      kind: "Event",
      metadata: { name: `${reason}.${kube.all("Event").length}`, namespace: NS },
      involvedObject: { kind: "Pod", name: handle.sandboxName, uid: pod.metadata.uid },
      reason,
      message,
      type: "Warning",
      lastTimestamp: new Date(T0 + clock.ms).toISOString(),
      ...extra,
    });
  return { kube, provider, handle, clock, ticks, setStatus, podEvent, pvc };
}

const noDeletes = (kube: FakeKube) => kube.calls.filter((c) => c.verb === "delete");

describe("awaitReady (KOBE-192)", () => {
  it("returns at once for a Ready pod", async () => {
    const t = await setup();
    t.setStatus(READY);
    await expect(t.provider.awaitReady(TEAM, USER, T0)).resolves.toEqual({ ready: true });
  });

  it("waits through a 60 s image pull (only Pulling events), then succeeds", async () => {
    const t = await setup();
    t.kube.seed({
      apiVersion: "v1",
      kind: "Event",
      metadata: { name: "pulling", namespace: NS },
      involvedObject: { kind: "Pod", name: t.handle.sandboxName, uid: "x" },
      reason: "Pulling",
      message: "Pulling image kobe-sandbox (1.5 GB)",
      type: "Normal",
      lastTimestamp: new Date(T0).toISOString(),
    });
    t.setStatus({
      phase: "Pending",
      containerStatuses: [{ state: { waiting: { reason: "ContainerCreating" } } }],
    });
    t.ticks.push((ms) => {
      if (ms >= 60_000) t.setStatus(READY);
    });
    await expect(t.provider.awaitReady(TEAM, USER, T0)).resolves.toEqual({ ready: true });
    expect(t.clock.ms).toBeGreaterThanOrEqual(60_000);
    expect(noDeletes(t.kube)).toEqual([]);
  });

  it("ignores a stale FailedMount from an earlier wake and waits the whole budget", async () => {
    const t = await setup(20_000);
    t.podEvent("FailedMount", "old attach problem", {
      lastTimestamp: new Date(T0 - 3_600_000).toISOString(),
      count: 20,
    });
    const outcome = await t.provider.awaitReady(TEAM, USER, T0);
    expect(outcome).toMatchObject({ ready: false, stall: { cause: "unknown", definite: false } });
    expect(t.clock.ms).toBeGreaterThanOrEqual(20_000);
  });

  it("fails early with an admin reason on FailedScheduling for insufficient storage", async () => {
    const t = await setup();
    t.podEvent("FailedScheduling", "0/4 nodes are available: 4 insufficient storage.");
    const outcome = await t.provider.awaitReady(TEAM, USER, T0);
    expect(outcome).toMatchObject({
      ready: false,
      sandboxId: t.handle.sandboxId,
      stall: { cause: "volume_unschedulable", definite: true },
    });
    expect(t.clock.ms).toBeLessThan(30_000);
  });

  it("fails early on a Longhorn replica scheduling failure", async () => {
    const t = await setup();
    t.podEvent("FailedAttachVolume", "LocalReplicaSchedulingFailure: insufficient storage");
    const outcome = await t.provider.awaitReady(TEAM, USER, T0);
    expect(outcome).toMatchObject({ ready: false, stall: { cause: "volume_unschedulable" } });
    expect(t.clock.ms).toBeLessThan(30_000);
  });

  it("never deletes anything, whatever it finds", async () => {
    const t = await setup(10_000);
    t.podEvent("FailedAttachVolume", "LocalReplicaSchedulingFailure: insufficient storage");
    await t.provider.awaitReady(TEAM, USER, T0);
    expect(noDeletes(t.kube)).toEqual([]);
    expect(t.kube.calls.filter((c) => c.verb === "patch")).toEqual([]);
    expect(t.kube.peek({ ...t.pvc, name: t.pvc.metadata.name, namespace: NS })).toBeDefined();
  });
});
