import type { KobeTx } from "@kobe/db";

/**
 * Seams to tables that don't exist yet. Each runs inside the caller's `withTeam` transaction, so
 * its eventual implementation reads under the active team's RLS.
 *
 * - Projects (KOBE-57): `viewerProjectIds` returns the active team's projects the viewer is a
 *   member of; threads shared to those projects become readable (D23). Until projects exist it is
 *   empty and no thread can be created in a project.
 * - Agents (KOBE-46): `resolveAgentPin` returns the version a new thread pins (D19). Agent
 *   definitions exist since KOBE-45 (team_agents / install_agents), but a pin needs a published
 *   version, which arrives with KOBE-46; until then only the install default agent (null) is
 *   accepted.
 */

export async function viewerProjectIds(_tx: KobeTx, _userId: string): Promise<readonly string[]> {
  return [];
}

export async function canCreateInProject(
  _tx: KobeTx,
  _userId: string,
  _projectId: string,
): Promise<boolean> {
  return false;
}

export type AgentPin = { readonly agentId: string; readonly agentVersion: number } | null;

/** The pin for `agentId` (its current published version), or undefined when it is not usable. */
export async function resolveAgentPin(
  _tx: KobeTx,
  _userId: string,
  agentId: string | null,
): Promise<AgentPin | undefined> {
  return agentId === null ? null : undefined;
}
