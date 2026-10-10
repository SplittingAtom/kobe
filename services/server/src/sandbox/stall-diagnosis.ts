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
  /**
   * A signal that waiting will not fix (replica cannot be scheduled, no nodes, an attach that
   * keeps failing, an image that cannot be pulled). Anything else (Pulling, ContainerCreating, a
   * single FailedMount) is progress and the wake keeps waiting.
   */
  readonly definite: boolean;
}

const MAX_DETAIL = 400;
/** FailedAttachVolume is definite after this many repeats, or once it has lasted this long. */
const ATTACH_REPEATS = 3;
const ATTACH_LASTING_MS = 60_000;
const VOLUME_SCHEDULING = /LocalReplicaSchedulingFailure|insufficient storage|replica scheduling/i;
const VOLUME_ATTACH = /FailedAttachVolume|AttachVolume\.Attach failed|FailedMount|MountVolume/i;
const NO_CAPACITY = /insufficient storage|no nodes available|nodes are available/i;
const IMAGE_PULL = /ErrImagePull|ImagePullBackOff|ErrImageNeverPull|InvalidImageName/i;

interface KubeEvent {
  readonly reason: string;
  readonly message: string;
  readonly type: string;
  readonly kind: string;
  readonly name: string;
  readonly at: number;
  readonly first: number;
  readonly count: number;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

function toEvent(o: KubeObject): KubeEvent {
  const involved = (o["involvedObject"] ?? {}) as Record<string, unknown>;
  const stamp =
    text(o["lastTimestamp"]) || text(o["eventTime"]) || text(o.metadata.creationTimestamp);
  return {
    reason: text(o["reason"]),
    message: text(o["message"]),
    type: text(o["type"]),
    kind: text(involved["kind"]),
    name: text(involved["name"]),
    at: Date.parse(stamp) || 0,
    first: Date.parse(text(o["firstTimestamp"]) || stamp) || 0,
    count: typeof o["count"] === "number" ? o["count"] : 1,
  };
}

function waitingReasons(pod: KubeObject | undefined): string[] {
  const status = (pod?.["status"] ?? {}) as Record<string, unknown>;
  const all = [
    ...((status["containerStatuses"] as unknown[]) ?? []),
    ...((status["initContainerStatuses"] as unknown[]) ?? []),
  ] as Record<string, Record<string, Record<string, unknown>> | undefined>[];
  return all.map((c) => text(c["state"]?.["waiting"]?.["reason"])).filter((r) => r !== "");
}

const clean = (s: string): string =>
  [...s]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, MAX_DETAIL);

/**
 * Pure classification of what was read (tested with fake API responses). Only events of this
 * wake (`since`, epoch ms) about this very pod or volume (matched by uid, not just name) count:
 * an earlier wake leftovers say nothing about now.
 */
export function classifyStall(input: {
  readonly pod: KubeObject | undefined;
  readonly pvc: KubeObject | undefined;
  readonly events: readonly KubeObject[];
  readonly since: number;
  readonly now: number;
}): StallDiagnosis {
  const { pod, pvc, since, now } = input;
  const uids = new Set(
    [pod?.metadata.uid, pvc?.metadata.uid].filter((u): u is string => typeof u === "string"),
  );
  const events = input.events
    .filter((o) => uids.has(text((o["involvedObject"] as Record<string, unknown>)?.["uid"])))
    .map(toEvent)
    .filter((e) => e.type !== "Normal" && e.at >= since)
    .sort((a, b) => b.at - a.at);
  const waiting = waitingReasons(pod);
  const volumePhase = text((pvc?.["status"] as Record<string, unknown> | undefined)?.["phase"]);
  const pick = (re: RegExp) => events.find((e) => re.test(`${e.reason} ${e.message}`));
  const line = (e: KubeEvent) => `${e.reason}: ${e.message}`;
  const make = (cause: StallCause, e: string, definite: boolean): StallDiagnosis => ({
    cause,
    detail: clean(e),
    definite,
    ...(volumePhase ? { volumePhase } : {}),
  });

  const replica = pick(VOLUME_SCHEDULING);
  if (replica) return make("volume_unschedulable", line(replica), true);
  const noRoom = events.find((e) => e.reason === "FailedScheduling" && NO_CAPACITY.test(e.message));
  if (noRoom) return make("scheduling", line(noRoom), true);
  const pull = pick(IMAGE_PULL);
  const pullWaiting = waiting.find((w) => IMAGE_PULL.test(w));
  if (pull || pullWaiting) return make("image_pull", pull ? line(pull) : (pullWaiting ?? ""), true);
  const attach = pick(VOLUME_ATTACH);
  if (attach) {
    // One FailedMount is normal while a volume attaches; a repeating FailedAttachVolume is not.
    const lasting =
      attach.reason === "FailedAttachVolume" &&
      (attach.count >= ATTACH_REPEATS || now - attach.first >= ATTACH_LASTING_MS);
    return make("volume_attach", line(attach), lasting);
  }
  const unschedulable = pick(/FailedScheduling/);
  if (unschedulable) return make("scheduling", line(unschedulable), false);
  const failedProvision = pick(/ProvisioningFailed/);
  if (failedProvision) return make("volume_unschedulable", line(failedProvision), false);
  const phase = text((pod?.["status"] as Record<string, unknown> | undefined)?.["phase"]);
  return make(
    "unknown",
    `pod ${phase || "missing"}${waiting.length ? ` (${waiting.join(", ")})` : ""}, volume ${volumePhase || "missing"}`,
    false,
  );
}

/** Reads the pod, the workspace PVC and the namespace events, then classifies them. */
export async function diagnoseStall(
  kube: KubeClient,
  namespace: string,
  podName: string,
  pvcName: string,
  since: number,
  now: number,
): Promise<StallDiagnosis> {
  const [pod, pvc, events] = await Promise.all([
    kube.get({ apiVersion: "v1", kind: "Pod", name: podName, namespace }),
    kube.get({ apiVersion: "v1", kind: "PersistentVolumeClaim", name: pvcName, namespace }),
    kube.list("v1", "Event", namespace),
  ]);
  return classifyStall({ pod, pvc, events, since, now });
}

/** Whether the pod Ready condition is True. */
export function isPodReady(pod: KubeObject | undefined): boolean {
  const conditions = ((pod?.["status"] as Record<string, unknown> | undefined)?.["conditions"] ??
    []) as { type?: string; status?: string }[];
  return conditions.some((c) => c.type === "Ready" && c.status === "True");
}
