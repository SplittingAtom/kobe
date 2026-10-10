import type { KubeClient } from "./kube.js";
import type { KubeObject } from "./manifests.js";

/**
 * Why a sandbox pod is not Ready (KOBE-192): classifies the pod's and the workspace volume's
 * events and conditions. `detail` names cluster internals (nodes, volumes) and is for install
 * admins and logs only; members only ever see the fixed `workspace_unavailable` message.
 */
export type StallCause =
  /** The volume's replica could not be scheduled (Longhorn: insufficient storage, strict-local). */
  | "volume_unschedulable"
  /** The volume exists but could not be attached or mounted. */
  | "volume_attach"
  | "scheduling"
  | "image_pull"
  | "unknown";

export interface StallDiagnosis {
  readonly cause: StallCause;
  /** One line for admins; control characters removed, bounded. */
  readonly detail: string;
  /** The workspace PVC's phase, if it exists. */
  readonly volumePhase?: string;
  /** No container of the pod has ever run (a precondition of the one-time volume retry). */
  readonly neverRan: boolean;
}

const MAX_DETAIL = 600;
const VOLUME_SCHEDULING = /LocalReplicaSchedulingFailure|insufficient storage|replica scheduling/i;
const VOLUME_ATTACH = /FailedAttachVolume|AttachVolume\.Attach failed|FailedMount|MountVolume/i;
const IMAGE_PULL = /ErrImagePull|ImagePullBackOff|ErrImageNeverPull|InvalidImageName/i;

interface KubeEvent {
  readonly reason: string;
  readonly message: string;
  readonly type: string;
  readonly kind: string;
  readonly name: string;
  readonly at: number;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

function toEvent(o: KubeObject): KubeEvent {
  const involved = (o["involvedObject"] ?? {}) as Record<string, unknown>;
  const stamp = text(o["lastTimestamp"]) || text(o["eventTime"]) || text(o.metadata.creationTimestamp);
  return {
    reason: text(o["reason"]),
    message: text(o["message"]),
    type: text(o["type"]),
    kind: text(involved["kind"]),
    name: text(involved["name"]),
    at: Date.parse(stamp) || 0,
  };
}

function containerStates(pod: KubeObject | undefined): { waiting: string[]; ran: boolean } {
  const status = (pod?.["status"] ?? {}) as Record<string, unknown>;
  const all = [
    ...((status["containerStatuses"] as unknown[]) ?? []),
    ...((status["initContainerStatuses"] as unknown[]) ?? []),
  ] as Record<string, Record<string, Record<string, unknown>> | undefined>[];
  const waiting: string[] = [];
  let ran = false;
  for (const c of all) {
    const state = c["state"] ?? {};
    const last = c["lastState"] ?? {};
    if (state["running"] || state["terminated"] || last["running"] || last["terminated"]) ran = true;
    const reason = text(state["waiting"]?.["reason"]);
    if (reason) waiting.push(reason);
  }
  return { waiting, ran };
}

const clean = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_DETAIL);

/** Pure classification of what was read (tested with fake API responses). */
export function classifyStall(input: {
  readonly pod: KubeObject | undefined;
  readonly pvc: KubeObject | undefined;
  readonly events: readonly KubeObject[];
  readonly podName: string;
  readonly pvcName: string;
}): StallDiagnosis {
  const { pod, pvc, podName, pvcName } = input;
  const events = input.events
    .map(toEvent)
    .filter(
      (e) =>
        e.type !== "Normal" &&
        ((e.kind === "Pod" && e.name === podName) ||
          (e.kind === "PersistentVolumeClaim" && e.name === pvcName)),
    )
    .sort((a, b) => b.at - a.at);
  const { waiting, ran } = containerStates(pod);
  const volumePhase = text((pvc?.["status"] as Record<string, unknown> | undefined)?.["phase"]);
  const pick = (re: RegExp) => events.find((e) => re.test(`${e.reason} ${e.message}`));
  const line = (e: KubeEvent) => `${e.reason}: ${e.message}`;
  const base = {
    neverRan: !ran,
    ...(volumePhase ? { volumePhase } : {}),
  };

  const scheduling = pick(VOLUME_SCHEDULING);
  if (scheduling) {
    return { ...base, cause: "volume_unschedulable", detail: clean(line(scheduling)) };
  }
  const attach = pick(VOLUME_ATTACH);
  if (attach) return { ...base, cause: "volume_attach", detail: clean(line(attach)) };
  const pull = pick(IMAGE_PULL) ?? undefined;
  const pullWaiting = waiting.find((w) => IMAGE_PULL.test(w));
  if (pull || pullWaiting) {
    return { ...base, cause: "image_pull", detail: clean(pull ? line(pull) : pullWaiting ?? "") };
  }
  const unschedulable = pick(/FailedScheduling/);
  if (unschedulable) return { ...base, cause: "scheduling", detail: clean(line(unschedulable)) };
  const failedProvision = pick(/ProvisioningFailed/);
  if (failedProvision) {
    return { ...base, cause: "volume_unschedulable", detail: clean(line(failedProvision)) };
  }
  const phase = text((pod?.["status"] as Record<string, unknown> | undefined)?.["phase"]);
  return {
    ...base,
    cause: "unknown",
    detail: clean(
      `pod ${phase || "missing"}${waiting.length ? ` (${waiting.join(", ")})` : ""}, volume ${volumePhase || "missing"}`,
    ),
  };
}

/** Reads the pod, the workspace PVC and the namespace's events, then classifies them. */
export async function diagnoseStall(
  kube: KubeClient,
  namespace: string,
  podName: string,
  pvcName: string,
): Promise<StallDiagnosis> {
  const [pod, pvc, events] = await Promise.all([
    kube.get({ apiVersion: "v1", kind: "Pod", name: podName, namespace }),
    kube.get({ apiVersion: "v1", kind: "PersistentVolumeClaim", name: pvcName, namespace }),
    kube.list("v1", "Event", namespace),
  ]);
  return classifyStall({ pod, pvc, events, podName, pvcName });
}

/** Whether the pod's Ready condition is True. */
export function isPodReady(pod: KubeObject | undefined): boolean {
  const conditions = ((pod?.["status"] as Record<string, unknown> | undefined)?.["conditions"] ??
    []) as { type?: string; status?: string }[];
  return conditions.some((c) => c.type === "Ready" && c.status === "True");
}
