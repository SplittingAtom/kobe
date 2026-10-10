import { describe, expect, it } from "vitest";
import { classifyStall, isPodReady } from "./stall-diagnosis.js";
import type { KubeObject } from "./manifests.js";

const SINCE = Date.parse("2026-10-09T10:00:00Z");
const NOW = SINCE + 20_000;
const iso = (offsetMs: number) => new Date(SINCE + offsetMs).toISOString();

const event = (
  kind: string,
  uid: string,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): KubeObject => ({
  apiVersion: "v1",
  kind: "Event",
  metadata: { name: `${uid}.${reason}.${message.length}`, namespace: "kobe-team-a" },
  involvedObject: { kind, name: kind === "Pod" ? "u-1" : "workspace-u-1", uid },
  reason,
  message,
  type: "Warning",
  lastTimestamp: iso(1_000),
  ...extra,
});
const pod = (status: Record<string, unknown> = {}): KubeObject => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "u-1", namespace: "kobe-team-a", uid: "pod-uid" },
  status,
});
const pvc = (phase: string): KubeObject => ({
  apiVersion: "v1",
  kind: "PersistentVolumeClaim",
  metadata: { name: "workspace-u-1", namespace: "kobe-team-a", uid: "pvc-uid" },
  status: { phase },
});
const podEv = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
  event("Pod", "pod-uid", reason, message, extra);
const classify = (events: KubeObject[], status: Record<string, unknown> = {}, now = NOW) =>
  classifyStall({ pod: pod(status), pvc: pvc("Bound"), events, since: SINCE, now });

describe("classifyStall: definite signals", () => {
  it("a Longhorn replica that cannot be scheduled", () => {
    const d = classify([
      podEv(
        "FailedAttachVolume",
        "AttachVolume.Attach failed: LocalReplicaSchedulingFailure: insufficient storage on node compute2",
      ),
    ]);
    expect(d).toMatchObject({
      cause: "volume_unschedulable",
      definite: true,
      volumePhase: "Bound",
    });
    expect(d.detail).toContain("compute2");
  });

  it("FailedScheduling for storage or no nodes available", () => {
    expect(
      classify([podEv("FailedScheduling", "0/4 nodes are available: insufficient storage")]),
    ).toMatchObject({
      definite: true,
    });
    expect(
      classify([podEv("FailedScheduling", "no nodes available to schedule pods")]),
    ).toMatchObject({
      cause: "scheduling",
      definite: true,
    });
  });

  it("image pull failures, by event or by container state", () => {
    expect(classify([podEv("Failed", "Failed to pull image: ErrImagePull")])).toMatchObject({
      cause: "image_pull",
      definite: true,
    });
    expect(
      classify([], { containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }] }),
    ).toMatchObject({ cause: "image_pull", definite: true });
  });

  it("FailedAttachVolume once it repeats or has lasted a minute", () => {
    const attach = (extra: Record<string, unknown>) =>
      podEv("FailedAttachVolume", "not ready", extra);
    expect(classify([attach({ count: 3 })]).definite).toBe(true);
    expect(classify([attach({ firstTimestamp: iso(0) })], {}, SINCE + 61_000).definite).toBe(true);
  });
});

describe("classifyStall: progress is not a stall", () => {
  it("a single FailedMount, a young FailedAttachVolume, Pulling and ContainerCreating keep waiting", () => {
    expect(classify([podEv("FailedMount", "Unable to attach or mount volumes")]).definite).toBe(
      false,
    );
    expect(
      classify([podEv("FailedAttachVolume", "not ready", { count: 1, firstTimestamp: iso(0) })])
        .definite,
    ).toBe(false);
    const pulling = event("Pod", "pod-uid", "Pulling", "Pulling image", { type: "Normal" });
    expect(
      classify([pulling], {
        containerStatuses: [{ state: { waiting: { reason: "ContainerCreating" } } }],
      }),
    ).toMatchObject({ cause: "unknown", definite: false });
    expect(
      classify([podEv("FailedScheduling", "pod has unbound PersistentVolumeClaims")]).definite,
    ).toBe(false);
  });
});

describe("classifyStall: only events of this wake about this pod and volume", () => {
  it("ignores a stale event from an earlier wake", () => {
    const stale = podEv("FailedMount", "old", { lastTimestamp: iso(-3_600_000), count: 9 });
    expect(classify([stale])).toMatchObject({ cause: "unknown", definite: false });
  });

  it("ignores events of another pod with the same name (uid differs) and of other objects", () => {
    const old = event(
      "Pod",
      "previous-pod-uid",
      "FailedAttachVolume",
      "LocalReplicaSchedulingFailure",
    );
    const other = event(
      "Pod",
      "someone-else",
      "FailedAttachVolume",
      "LocalReplicaSchedulingFailure",
    );
    expect(classify([old, other]).cause).toBe("unknown");
  });

  it("reads PVC events by the volume uid", () => {
    const d = classify([
      event("PersistentVolumeClaim", "pvc-uid", "ProvisioningFailed", "no capacity"),
    ]);
    expect(d).toMatchObject({ cause: "volume_unschedulable", definite: false });
  });

  it("strips control characters and bounds the text", () => {
    const d = classify([podEv("FailedMount", `a\n${String.fromCharCode(0)}${"x".repeat(2000)}`)]);
    expect(d.detail.length).toBeLessThanOrEqual(400);
    expect(d.detail).not.toContain("\n");
    expect(d.detail).not.toContain(String.fromCharCode(0));
  });

  it("describes an unknown stall by phases", () => {
    const d = classifyStall({
      pod: pod({ phase: "Pending" }),
      pvc: undefined,
      events: [],
      since: SINCE,
      now: NOW,
    });
    expect(d).toMatchObject({ cause: "unknown", detail: "pod Pending, volume missing" });
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
