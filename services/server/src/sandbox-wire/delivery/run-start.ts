import {
  CAPABILITY_APP_CARDS,
  CAPABILITY_FILE_EDITS,
  CAPABILITY_MCP,
  CAPABILITY_MEMORY,
  CAPABILITY_PROJECTS,
  CAPABILITY_SYNC_CONFLICTS,
  type RunStartFrame,
  type ServerToSandboxFrame,
} from "@kobe/protocol";
import { untoldNotes, type AgentNotes } from "../../sync-conflicts/store.js";
import type { CommandRow } from "../commands.js";
import type { DeliveryEnv } from "./env.js";
import { memoryPlan, runStartMemory, type MemoryRecord } from "./memory-plan.js";

/** What a `run.start` remembers until the sandbox accepts it (`settle`). */
export interface RunStartHooks {
  /** Freshly picked memories, recorded on acceptance (KOBE-382). */
  recordMemory(pending: MemoryRecord): void;
  /** Sync conflict ids the start carried, marked told on acceptance (KOBE-492). */
  conflictsCarried(ids: readonly string[]): void;
}

/**
 * The `run.start` as this agent may take it (KOBE-707: moved out of delivery.ts): the member's
 * project files reconciled first, memory and sync conflicts added, and every field the agent did
 * not announce left out (an older agent runs without it rather than failing on an unknown key).
 */
export async function prepareRunStart(
  env: DeliveryEnv,
  row: CommandRow,
  frame: RunStartFrame,
  start: ServerToSandboxFrame,
  hooks: RunStartHooks,
): Promise<ServerToSandboxFrame> {
  const { host } = env;
  let out = start;
  // Project files: the user's workspace is brought in line with their memberships before the
  // sandbox pulls it at run start (KOBE-162). Never blocks or fails the run; see ProjectMounts.
  // An eval sandbox (KOBE-325) has no member workspace and gets no memory: an eval sees only
  // its case's fixtures, the same for every member.
  const evalSandbox = host.target.evalThreadId !== undefined;
  if (!evalSandbox) {
    const { teamId, userId } = host.target;
    await env.ctx.projectMounts?.reconcileUser(teamId, userId);
  }
  // Memory indexes only reach agents that know the field (KOBE-156).
  // The agent version's memory setting (KOBE-646): `off` sends no memory at all (the sandbox
  // then lists no memory tools; the policy check denies them too).
  // Semantic memory (KOBE-382) rides inside it, only for agents announcing `semantic_memory`:
  // the full block for `all`, Site Policy alone for `notes_only` and `off` (Policy reaches every
  // run, Chris 2026-11-13), nothing for evals, eval cases or builder test chats.
  const plan =
    !evalSandbox && host.hasCapability(CAPABILITY_MEMORY)
      ? await memoryPlan(env, row.runId)
      : undefined;
  if (plan !== undefined && row.runId !== null) {
    const run = { runId: row.runId, threadId: row.threadId };
    const memory = await runStartMemory(env, plan, run, frame, hooks.recordMemory);
    if (memory) out = { ...out, memory } as ServerToSandboxFrame;
  }
  // Project instructions only reach agents that know the field (KOBE-159): an older agent runs
  // without them rather than failing on an unknown key.
  if (!host.hasCapability(CAPABILITY_PROJECTS)) {
    const { project: _project, ...rest } = out as RunStartFrame;
    out = rest as ServerToSandboxFrame;
  }
  // App cards (KOBE-440): an agent that cannot append them starts below them (Pi does not know
  // them), so its model does not see them, and the run does not fail on an unknown parent.
  if (!host.hasCapability(CAPABILITY_APP_CARDS)) {
    out = withoutAppCards(out as RunStartFrame) as ServerToSandboxFrame;
  }
  // The viewed file (KOBE-462) only reaches agents that fence it; an older one runs without it.
  if (!host.hasCapability(CAPABILITY_FILE_EDITS)) {
    const { viewing: _viewing, ...rest } = out as RunStartFrame;
    out = rest as ServerToSandboxFrame;
  }
  // Sync conflicts of this thread its agent was not told about (KOBE-492): marked told here.
  if (!evalSandbox && host.hasCapability(CAPABILITY_SYNC_CONFLICTS)) {
    const notes = await runConflicts(env, row.threadId);
    if (notes.conflicts.length > 0) {
      out = { ...out, sync_conflicts: [...notes.conflicts] } as ServerToSandboxFrame;
      // Told once the sandbox accepts the run (`settle`); a lost start leaves them untold.
      hooks.conflictsCarried(notes.ids);
    }
  }
  // Same for the per-session MCP config (KOBE-111): an agent without it has no connector tools.
  if (!host.hasCapability(CAPABILITY_MCP)) {
    const { mcp: _mcp, ...rest } = out as RunStartFrame;
    out = rest as ServerToSandboxFrame;
  }
  return out;
}

/** A start without its app cards: the branch point moves to the first card's parent. */
export function withoutAppCards(frame: RunStartFrame): RunStartFrame {
  const { app_cards: cards, parent_entry_id: _parent, ...rest } = frame;
  if (cards === undefined || cards.length === 0) return frame;
  const below = cards[0]?.parentId ?? null;
  return below === null ? rest : { ...rest, parent_entry_id: below };
}

/** `run.start.sync_conflicts`; a failed read means no note (the rows stay untold). */
async function runConflicts(env: DeliveryEnv, threadId: string): Promise<AgentNotes> {
  try {
    const { teamId, userId } = env.host.target;
    return await untoldNotes(env.ctx.db, { teamId, userId }, threadId);
  } catch (err) {
    env.host.log.warn({ err }, "run.start.sync_conflicts could not be read; sent without it");
    return { ids: [], conflicts: [] };
  }
}
