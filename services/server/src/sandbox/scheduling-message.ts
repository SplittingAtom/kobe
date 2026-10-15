/**
 * What a kube-scheduler FailedScheduling message says about waiting (KOBE-277). The message reads
 * "0/N nodes are available: <count> <reason>, <count> <reason>. preemption: ...". Most reasons do
 * not clear by themselves (Insufficient cpu, Too many pods, volume node affinity conflict, a
 * taint), but a workspace volume that agent-sandbox has not created or bound yet is the normal
 * race of a first wake. Waiting can help only while every node's blocker is such a pending volume.
 */
export type SchedulingVerdict = "blocked" | "volume_pending" | "unknown";

const PENDING_VOLUME =
  /persistentvolumeclaim\s+"[^"]*"\s+not found|unbound (immediate )?PersistentVolumeClaims|didn't find available persistent volumes|waiting for first consumer/i;
const HEADER = /^0\/(\d+) nodes are available:\s*(.*)$/is;
const COUNTED = /^(\d+)\s+(.*)$/s;

export function judgeScheduling(message: string): SchedulingVerdict {
  const head = message.split(/\.?\s*preemption:/i)[0] ?? "";
  const header = HEADER.exec(head.trim());
  if (!header) {
    if (/no nodes available/i.test(message)) return "blocked";
    return PENDING_VOLUME.test(message) ? "volume_pending" : "unknown";
  }
  const nodes = Number(header[1]);
  const reasons = (header[2] ?? "")
    .split(/,\s+/)
    .map((r) => r.trim().replace(/\.$/, ""))
    .filter((r) => r !== "");
  let pending = false;
  let blockedNodes = 0;
  for (const reason of reasons) {
    const counted = COUNTED.exec(reason);
    // A reason without a count (a missing PVC) applies to every node.
    const count = counted ? Number(counted[1]) : nodes;
    const what = counted ? (counted[2] ?? "") : reason;
    if (PENDING_VOLUME.test(what)) pending = true;
    else blockedNodes += count;
  }
  // Nothing pending: as before KOBE-277, the cluster cannot place the pod. With a pending volume,
  // the pod is stuck only if every node also has a blocker that waiting will not clear.
  if (!pending || blockedNodes >= nodes) return "blocked";
  return "volume_pending";
}
