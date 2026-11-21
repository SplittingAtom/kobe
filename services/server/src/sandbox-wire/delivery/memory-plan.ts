import { withTeam } from "@kobe/db";
import {
  CAPABILITY_SEMANTIC_MEMORY,
  CAPABILITY_SEMANTIC_MEMORY_PLACEMENT,
  type RunSemanticMemory,
  type RunSemanticMemoryItem,
  type RunStartFrame,
} from "@kobe/protocol";
import { readRunMemoryPlan, type RunMemoryPlan } from "../../agents/run-memory.js";
import { buildRunMemory } from "../../memory/agent.js";
import { buildPolicyOnly, buildRunSemantic } from "../../memory/items/run-memory.js";
import { startVectorLeg } from "../../memory/items/vector-leg.js";
import type { DeliveryEnv } from "./env.js";

/** The memory a `run.start` carries (KOBE-156, KOBE-382, KOBE-646; moved out of delivery.ts). */

/** Freshly picked memories to record once the sandbox accepts the start. */
export interface MemoryRecord {
  readonly runId: string;
  readonly items: readonly RunSemanticMemoryItem[];
}

/** The run's memory plan (KOBE-646); unreadable means no memory (fail closed). */
export async function memoryPlan(
  env: DeliveryEnv,
  runId: string | null,
): Promise<RunMemoryPlan | undefined> {
  if (runId === null) return undefined;
  const { teamId } = env.host.target;
  try {
    return await withTeam(env.ctx.db, teamId, (tx) => readRunMemoryPlan(tx, { teamId, runId }));
  } catch (err) {
    env.host.log.warn({ err }, "the run's memory setting could not be read; sent without memory");
    return undefined;
  }
}

/** `run.start.memory`; a failed read means no context (every memory call is still enforced). */
export async function runMemory(
  env: DeliveryEnv,
  threadId: string,
): Promise<Awaited<ReturnType<typeof buildRunMemory>> | undefined> {
  try {
    return await buildRunMemory(env.ctx.memory, { ...env.host.target, threadId });
  } catch (err) {
    env.host.log.warn({ err }, "run.start.memory could not be built; sent without it");
    return undefined;
  }
}

/**
 * `run.start.memory.semantic` (KOBE-382), picked for this message and recorded with the run. A
 * failure sends the run without the block (fail closed: nothing recorded either).
 */
export async function runSemantic(
  env: DeliveryEnv,
  runId: string,
  threadId: string,
  message: string,
  opts: { readonly policyOnly: boolean; readonly agentPlaces: boolean },
): Promise<{ readonly semantic: RunSemanticMemory; readonly fresh: boolean } | undefined> {
  const { teamId, userId } = env.host.target;
  // KOBE-409: the vector leg (query embedding, paid by the run's member, then the nearest items)
  // starts once the switches allow a lane and runs beside the keyword read; late or failed:
  // keywords alone.
  const embeddings = env.ctx.memoryEmbeddings;
  const vectorLeg =
    opts.policyOnly || embeddings === undefined
      ? undefined
      : () =>
          startVectorLeg(
            env.ctx.db,
            { teamId, userId },
            embeddings.queryVector({ teamId, userId, threadId, runId, message }),
          );
  const input = {
    teamId,
    userId,
    threadId,
    runId,
    message,
    ...opts,
    ...(vectorLeg ? { vectorLeg } : {}),
  };
  try {
    return await withTeam(env.ctx.db, teamId, (tx) => buildRunSemantic(tx, input));
  } catch (err) {
    env.host.log.warn({ err }, "run.start.memory.semantic could not be built; Policy only");
  }
  // Fail closed to Policy only (L5): a broken lane never drops the Site's Policy.
  try {
    const policy = await withTeam(env.ctx.db, teamId, (tx) => buildPolicyOnly(tx, input));
    return policy === undefined ? undefined : { semantic: policy, fresh: true };
  } catch (err) {
    env.host.log.warn({ err }, "run.start Site Policy could not be read; sent without it");
    return undefined;
  }
}

/**
 * `run.start.memory` for a plan: Notes when the plan has them, semantic memory (or Site Policy
 * alone) for agents announcing `semantic_memory`; undefined when there is nothing to send.
 * `record` gets freshly picked memories, recorded once the sandbox accepts the start.
 */
export async function runStartMemory(
  env: DeliveryEnv,
  plan: RunMemoryPlan,
  run: { readonly runId: string; readonly threadId: string },
  frame: RunStartFrame,
  record: (pending: MemoryRecord) => void,
) {
  const memory = plan.notes ? await runMemory(env, run.threadId) : undefined;
  const semantic =
    plan.policy && env.host.hasCapability(CAPABILITY_SEMANTIC_MEMORY)
      ? await runSemantic(env, run.runId, run.threadId, frame.message, {
          policyOnly: !plan.semantic,
          // KOBE-658: an agent that renders the placement gets the Site's; others `system`.
          agentPlaces: env.host.hasCapability(CAPABILITY_SEMANTIC_MEMORY_PLACEMENT),
        })
      : undefined;
  if (!memory && !semantic) return undefined;
  // Without Notes (`off`, or their read failed) the envelope lists no Notes scope.
  const notes = memory ?? { scopes: [], indexes: [] };
  // Recorded once the sandbox accepts the start (`settle`), as sync conflicts are told.
  if (semantic?.fresh === true) record({ runId: run.runId, items: semantic.semantic.items });
  return semantic ? { ...notes, semantic: semantic.semantic } : notes;
}
