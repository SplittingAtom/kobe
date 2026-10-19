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

/** The eval quota: `maxConcurrentPerTeam` eval pods. */
export function evalQuotaHard(s: SandboxSettings): Record<string, string> {
  const n = s.skillEval.maxConcurrentPerTeam;
  return Object.fromEntries(Object.entries(perPod(s)).map(([k, v]) => [k, scaleQuantity(v, n)]));
}

/** Quota keys a PriorityClass-scoped quota may hold (pod resources; no storage or PVC counts). */
const POD_SCOPED =
  /^(pods|cpu|memory|ephemeral-storage|(requests|limits)\.(cpu|memory|ephemeral-storage))$/;

/**
 * The members' own quota (scoped to pods without the eval PriorityClass, a pod with none
 * included, checked on k3s 1.34): `teamQuota`'s pod keys, so members never use the eval share.
 */
export function memberQuotaHard(s: SandboxSettings): Record<string, string> {
  return Object.fromEntries(Object.entries(s.teamQuota).filter(([k]) => POD_SCOPED.test(k)));
}

/**
 * The team quota's hard limits: the members' (`teamQuota`) plus the eval quota, for the keys the
 * team quota sets. Eval pods count in both, so they can use at most the eval share and members
 * always keep theirs.
 */
export function teamQuotaHard(s: SandboxSettings): Record<string, string> {
  const evals = evalQuotaHard(s);
  return Object.fromEntries(
    Object.entries(s.teamQuota).map(([k, v]) => {
      const extra = evals[k];
      return [k, extra === undefined ? v : addQuantities(v, extra)];
    }),
  );
}
