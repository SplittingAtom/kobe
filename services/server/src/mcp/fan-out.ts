import type { PolicyDecision, PolicyEngine, ToolRegistry } from "@kobe/protocol";
import {
  createPolicyEngine,
  type ConnectorStateSource,
  type PolicyRuleSource,
  type PolicySettingsSource,
} from "../policy/engine.js";
import type { ActiveRunContext } from "./run-context.js";

/**
 * Bounded fan-out for the MCP re-check (KOBE-58 review M1 follow-up). A call is decided under every
 * active run of the sandbox, which must not cost one full policy evaluation per run against a small
 * connection pool:
 * - runs with the same policy context (mode, trigger, agent allow/deny lists, project) are decided
 *   once: the engine's answer depends on nothing else of the run;
 * - the rules, settings, tool resolution and connector state are loaded once per call (memoised
 *   sources behind a per-call engine), so each extra context is evaluation, not queries;
 * - at most `DECISION_CONCURRENCY` decisions run at a time.
 */

export const DECISION_CONCURRENCY = 3;

/** The inputs the engine reads, shared by every decision of one call. */
export interface PolicySources {
  readonly rules: PolicyRuleSource;
  readonly settings: PolicySettingsSource;
  readonly registry: ToolRegistry;
  readonly connectors: ConnectorStateSource;
  readonly onError?: (error: unknown) => void;
}

/** Memoises by the arguments `keyOf` picks (the first call's other arguments win). */
function memo<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  keyOf: (...args: A) => string = (...args) => JSON.stringify(args),
): (...args: A) => Promise<R> {
  const cache = new Map<string, Promise<R>>();
  return (...args) => {
    const key = keyOf(...args);
    let hit = cache.get(key);
    if (!hit) {
      hit = fn(...args);
      cache.set(key, hit);
    }
    return hit;
  };
}

/** A fresh engine over memoised sources: use it for the decisions of one call only. */
export function engineForCall(sources: PolicySources): PolicyEngine {
  return createPolicyEngine({
    rules: {
      load: memo(
        (teamId: string, userId: string, now: Date) => sources.rules.load(teamId, userId, now),
        // One call's decisions share one rule set (expiry as of the first decision).
        (teamId, userId) => `${teamId}:${userId}`,
      ),
    },
    settings: { get: memo(() => sources.settings.get()) },
    registry: {
      resolve: memo((teamId: string, name: string) => sources.registry.resolve(teamId, name)),
    },
    connectors: { get: memo((teamId: string, id: string) => sources.connectors.get(teamId, id)) },
    ...(sources.onError ? { onError: sources.onError } : {}),
  });
}

export function policyContextKey(run: ActiveRunContext): string {
  return JSON.stringify([
    run.mode,
    run.trigger,
    [...run.toolsAllow].sort(),
    [...run.toolsDeny].sort(),
    run.projectId ?? null,
  ]);
}

/** Sibling runs whose policy context differs from the named run's and from each other's. */
export function distinctSiblings(
  named: ActiveRunContext,
  runs: readonly ActiveRunContext[],
): ActiveRunContext[] {
  const seen = new Set([policyContextKey(named)]);
  const out: ActiveRunContext[] = [];
  for (const run of runs) {
    const key = policyContextKey(run);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(run);
  }
  return out;
}

/** `decide` over `items`, at most `limit` at a time, results in order. */
export async function mapLimited<T>(
  items: readonly T[],
  limit: number,
  decide: (item: T) => Promise<PolicyDecision>,
): Promise<PolicyDecision[]> {
  const results: PolicyDecision[] = new Array<PolicyDecision>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await decide(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
