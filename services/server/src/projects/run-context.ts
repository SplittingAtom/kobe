import type { KobeTx } from "@kobe/db";
import {
  PROJECT_INSTRUCTIONS_MAX_BYTES,
  projectMountPath,
  type RunProjectContext,
} from "@kobe/protocol";
import { canPinAgent, findPinnableAgent } from "../agents/versions.js";
import { loadAccess } from "./access.js";

/** `text` cut to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * The `run.start.project` context for a run on a thread in a project (KOBE-159 contract): the
 * project's instructions, applied to every run of every thread in it. Only while the thread's
 * owner (whose sandbox runs it) may converse in the project (PR3; team admins included): a removed
 * member's old threads stop receiving the instructions. `access` (PR3, CM6) is `write` when the
 * owner may edit the project (editor, owner, team admin) and `read` for a reader; whether a
 * checkout exists is not part of it (the commit itself checks, KOBE-579/580). The create/update
 * API refuses over-long instructions, so truncation (with `truncated: true`) only covers an old
 * over-long row.
 */
export async function projectRunContext(
  tx: KobeTx,
  owner: { teamId: string; userId: string },
  projectId: string | null,
): Promise<RunProjectContext | undefined> {
  if (projectId === null) return undefined;
  const access = await loadAccess(tx, owner, projectId);
  if (!access?.can.converse) return undefined;
  const { project } = access;
  const cut = truncateUtf8(project.instructions, PROJECT_INSTRUCTIONS_MAX_BYTES);
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    instructions: cut.text,
    ...(cut.truncated ? { truncated: true } : {}),
    mount: projectMountPath(project.slug),
    access: access.can.edit ? "write" : "read",
  };
}

/**
 * The project's default agent for a new thread without an agent of its own, when the creator can
 * still start threads with it; otherwise null (the team default), never an error.
 */
export async function projectDefaultAgent(
  tx: KobeTx,
  viewer: { teamId: string; userId: string },
  projectId: string | null,
): Promise<string | null> {
  if (projectId === null) return null;
  const access = await loadAccess(tx, viewer, projectId);
  const agentId = access?.project.defaultAgentId ?? null;
  if (agentId === null) return null;
  const agent = await findPinnableAgent(tx, viewer, agentId);
  return agent !== null && canPinAgent(agent) ? agentId : null;
}
