import { isKubeStatus, type KubeClient, type ObjectRef } from "./kube.js";
import {
  EVAL_NETWORK_POLICY,
  LABEL_TEAM_ID,
  LABEL_TEAM_NAMESPACE,
  NETWORK_POLICY,
  TEAM_NAMESPACE_PREFIX,
} from "./constants.js";
import { assertTeamRef, type KubeObject, type TeamRef } from "./manifests.js";

/** Team namespaces converged at once: bounded so a large install does not flood the API server. */
export const TEAM_RECONCILE_CONCURRENCY = 4;

export interface TeamReconcileSummary {
  /** Team namespaces found. */
  readonly namespaces: number;
  /** Converged without error (idempotent: unchanged ones count too). */
  readonly converged: number;
  /** Not touched: being deleted, or labelled with an invalid team (never ours to converge). */
  readonly skipped: number;
  readonly failed: number;
  /** Namespaces whose NetworkPolicy spec changed; their awake sandboxes now run under new rules. */
  readonly policyChanged: readonly string[];
  readonly durationMs: number;
}

export interface TeamReconcileOptions {
  readonly kube: KubeClient;
  /** The provider's own convergence function (the one sandbox setup uses). */
  readonly converge: (team: TeamRef) => Promise<unknown>;
  readonly concurrency?: number;
  readonly now?: () => number;
  /** Per-namespace failure: name and error only, never object content. */
  readonly onFailure?: (namespace: string, err: unknown) => void;
}

const POLICY = (name: string, namespace: string): ObjectRef => ({
  apiVersion: "networking.k8s.io/v1",
  kind: "NetworkPolicy",
  name,
  namespace,
});

/** The specs of the managed NetworkPolicies, to tell whether a convergence changed them. */
async function policySpecs(kube: KubeClient, namespace: string): Promise<string> {
  const objects: (KubeObject | undefined)[] = await Promise.all(
    [NETWORK_POLICY, EVAL_NETWORK_POLICY].map((n) => kube.get(POLICY(n, namespace))),
  );
  return JSON.stringify(objects.map((o) => o?.spec ?? null));
}

/** The team a managed namespace belongs to, from its labels and name; undefined if malformed. */
export function teamOfNamespace(ns: KubeObject): TeamRef | undefined {
  const id = ns.metadata.labels?.[LABEL_TEAM_ID];
  const name = ns.metadata.name;
  if (!id || !name.startsWith(TEAM_NAMESPACE_PREFIX)) return undefined;
  const team = { id, slug: name.slice(TEAM_NAMESPACE_PREFIX.length) };
  try {
    assertTeamRef(team);
  } catch {
    return undefined; // not a namespace this server created
  }
  return team;
}

/**
 * Converges every team namespace (labelled team-namespace=true, so objects Kobe does not own are
 * never listed) with the same function sandbox setup uses. One failing namespace never stops the
 * rest; nothing is deleted.
 */
export async function reconcileTeamNamespaces(
  options: TeamReconcileOptions,
): Promise<TeamReconcileSummary> {
  const { kube, converge, now = () => Date.now() } = options;
  const started = now();
  const namespaces = await kube.list("v1", "Namespace", undefined, `${LABEL_TEAM_NAMESPACE}=true`);
  const queue = [...namespaces];
  const policyChanged: string[] = [];
  let converged = 0;
  let skipped = 0;
  let failed = 0;

  const one = async (ns: KubeObject): Promise<void> => {
    const team = teamOfNamespace(ns);
    if (!team || ns.metadata.deletionTimestamp) {
      skipped++;
      return;
    }
    try {
      const before = await policySpecs(kube, ns.metadata.name);
      await converge(team);
      const after = await policySpecs(kube, ns.metadata.name);
      if (before !== after) policyChanged.push(ns.metadata.name);
      converged++;
    } catch (err) {
      // Only a namespace deleted mid-run is skipped; every other error is a failure.
      if (isKubeStatus(err, 404)) skipped++;
      else {
        failed++;
        options.onFailure?.(ns.metadata.name, err);
      }
    }
  };

  const worker = async (): Promise<void> => {
    for (let ns = queue.shift(); ns; ns = queue.shift()) await one(ns);
  };
  const workers = Math.max(1, options.concurrency ?? TEAM_RECONCILE_CONCURRENCY);
  await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, worker));

  return {
    namespaces: namespaces.length,
    converged,
    skipped,
    failed,
    policyChanged: policyChanged.sort(),
    durationMs: now() - started,
  };
}
