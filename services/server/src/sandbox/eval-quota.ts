import type { SandboxSettings } from "./config.js";
import { addQuantities, scaleQuantity } from "./quantities.js";

// The skill-eval share of a team's quota (KOBE-325).

/** Resource keys of one eval pod, as the quota counts them. */
function perPod(s: SandboxSettings): Record<string, string> {
  return {
    pods: "1",
    "requests.cpu": s.resources.requests.cpu,
    "requests.memory": s.resources.requests.memory,
    "limits.cpu": s.resources.limits.cpu,
    "limits.memory": s.resources.limits.memory,
    "requests.ephemeral-storage": s.ephemeralStorage.request,
    "limits.ephemeral-storage": s.ephemeralStorage.limit,
  };
}

/** What `maxConcurrentPerTeam` eval pods may use in all (the team quota adds it). */
export function evalShare(s: SandboxSettings): Record<string, string> {
  const n = s.skillEval.maxConcurrentPerTeam;
  return Object.fromEntries(Object.entries(perPod(s)).map(([k, v]) => [k, scaleQuantity(v, n)]));
}

/**
 * Quota keys a PriorityClass-scoped quota may hold: pod count, CPU and memory. Checked against the
 * k3s 1.34 API server (2026-10-19): it refuses `ephemeral-storage` and its requests/limits under
 * the PriorityClass scope ("unsupported scope applied to resource"), like storage, PVCs, services
 * and object counts, which stay in the unscoped team quota.
 */
export const POD_SCOPED_QUOTA_KEYS: ReadonlySet<string> = new Set([
  "pods",
  "cpu",
  "memory",
  "requests.cpu",
  "requests.memory",
  "limits.cpu",
  "limits.memory",
]);

const scoped = (hard: Record<string, string>) =>
  Object.fromEntries(Object.entries(hard).filter(([k]) => POD_SCOPED_QUOTA_KEYS.has(k)));

/**
 * The eval quota (scoped to the eval PriorityClass): the eval share's pod count, CPU and memory.
 * Ephemeral storage stays bounded through the pod count: each eval pod has its own limit, so
 * `maxConcurrentPerTeam` of them never use more than the eval share the team quota adds.
 */
export function evalQuotaHard(s: SandboxSettings): Record<string, string> {
  return scoped(evalShare(s));
}

/**
 * The members' own quota (scoped to pods without the eval PriorityClass, a pod with none
 * included, checked on k3s 1.34): `teamQuota`'s pod keys, so members never use the eval share.
 */
export function memberQuotaHard(s: SandboxSettings): Record<string, string> {
  return scoped(s.teamQuota);
}

/**
 * The team quota's hard limits: the members' (`teamQuota`) plus the eval quota, for the keys the
 * team quota sets. Eval pods count in both, so they can use at most the eval share and members
 * always keep theirs.
 */
export function teamQuotaHard(s: SandboxSettings): Record<string, string> {
  const evals = evalShare(s);
  return Object.fromEntries(
    Object.entries(s.teamQuota).map(([k, v]) => {
      const extra = evals[k];
      return [k, extra === undefined ? v : addQuantities(v, extra)];
    }),
  );
}
