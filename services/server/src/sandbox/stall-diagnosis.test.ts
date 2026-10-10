import { describe, expect, it } from "vitest";
import { classifyStall, isPodReady } from "./stall-diagnosis.js";
import type { KubeObject } from "./manifests.js";

const event = (
  kind: string,
  name: string,
  reason: string,
  message: string,
  type = "Warning",
  lastTimestamp = "2026-10-09T10:00:00Z",
): KubeObject => ({
  apiVersion: "v1",
  kind: "Event",
  metadata: { name: `${name}.${reason}`, namespace: "kobe-team-a" },
  involvedObject: { kind, name },
  reason,
  message,
  type,
  lastTimestamp,
});
const pod = (status: Record<string, unknown> = {}): KubeObject => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "u-1", namespace: "kobe-team-a" },
  status,
});
const pvc = (phase: string): KubeObject => ({
  apiVersion: "v1",
  kind: "PersistentVolumeClaim",
  metadata: { name: "workspace-u-1", namespace: "kobe-team-a" },
  status: { phase },
});
const base = { podName: "u-1", pvcName: "workspace-u-1" };

describe("classifyStall", () => {
  it("recognises a Longhorn replica that cannot be scheduled", () => {
    const d = classifyStall({
      ...base,
      pod: pod({ phase: "Pending" }),
      pvc: pvc("Bound"),
      events: [
        event(
          "Pod",
          "u-1",
          "FailedAttachVolume",
          "AttachVolume.Attach failed for volume pvc-1: rpc error: LocalReplicaSchedulingFailure: insufficient storage on node compute2",
        ),
      ],
    });
    expect(d.cause).toBe("volume_unschedulable");
    expect(d.detail).toContain("compute2");
    expect(d.volumePhase).toBe("Bound");
    expect(d.neverRan).toBe(true);
  });

  it("recognises an attach failure, a scheduling failure and an image pull failure", () => {
    const run = (events: KubeObject[], status: Record<string, unknown> = {}) =>
      classifyStall({ ...base, pod: pod(status), pvc: pvc("Bound"), events }).cause;
    expect(
      run([event("Pod", "u-1", "FailedAttachVolume", "volume is not ready for workloads")]),
    ).toBe("volume_attach");
    expect(run([event("Pod", "u-1", "FailedMount", "Unable to attach or mount volumes")])).toBe(
      "volume_attach",
    );
    expect(run([event("Pod", "u-1", "FailedScheduling", "0/4 nodes are available")])).toBe(
      "scheduling",
    );
    expect(run([event("Pod", "u-1", "Failed", "Failed to pull image: ErrImagePull")])).toBe(
      "image_pull",
    );
    expect(
      run([], { containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }] }),
    ).toBe("image_pull");
  });

  it("reads PVC events and ignores Normal events and other objects", () => {
    expect(
      classifyStall({
        ...base,
        pod: pod(),
        pvc: pvc("Pending"),
        events: [
          event("PersistentVolumeClaim", "workspace-u-1", "ProvisioningFailed", "no capacity"),
          event("Pod", "someone-else", "FailedAttachVolume", "x"),
          event("Pod", "u-1", "FailedAttachVolume", "x", "Normal"),
        ],
      }).cause,
    ).toBe("volume_unschedulable");
  });

  it("falls back to unknown with the phases, strips control characters and bounds the text", () => {
    const d = classifyStall({
      ...base,
      pod: pod({ phase: "Pending" }),
      pvc: undefined,
      events: [],
    });
    expect(d).toMatchObject({ cause: "unknown", detail: "pod Pending, volume missing" });
    const long = classifyStall({
      ...base,
      pod: pod(),
      pvc: pvc("Bound"),
      events: [
        event("Pod", "u-1", "FailedMount", `a\n${String.fromCharCode(0)}${"x".repeat(2000)}`),
      ],
    });
    expect(long.detail.length).toBeLessThanOrEqual(600);
    expect(long.detail).not.toContain("\n");
    expect(long.detail).not.toContain(String.fromCharCode(0));
  });

  it("notes when a container has run before", () => {
    const d = classifyStall({
      ...base,
      pod: pod({ containerStatuses: [{ state: { waiting: {} }, lastState: { terminated: {} } }] }),
      pvc: pvc("Bound"),
      events: [],
    });
    expect(d.neverRan).toBe(false);
  });
});

describe("isPodReady", () => {
  it("needs the Ready condition to be True", () => {
    expect(isPodReady(pod({ conditions: [{ type: "Ready", status: "True" }] }))).toBe(true);
    expect(isPodReady(pod({ conditions: [{ type: "Ready", status: "False" }] }))).toBe(false);
    expect(isPodReady(pod())).toBe(false);
    expect(isPodReady(undefined)).toBe(false);
  });
});
