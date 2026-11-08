import { and, eq, siteAgentVersions, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { validateAgentDefinition } from "@kobe/agent-file";
import { recordAudit } from "../audit/record.js";
import type { RosterTarget } from "./access.js";
import { siteEntry, teamEntry, type RosterEntryRecord } from "./roster.js";
import { audit, lockPersonalAgent, lockRoster, writeEntry } from "./roster-writes.js";
import { insertAgent, type AgentLocation, type AgentRecord, type CreateError } from "./store.js";

/**
 * Adopt (KOBE-568, agents-roster AR10): a roster's admin copies an assigned entry's agent, at its
 * current published version, into an agent the roster owns, and the entry is removed, in one
 * transaction. Team roster → a team-owned agent (team admins; the adopter is its creator); site
 * roster → a site-owned gallery agent without a repository key (site admins), which the seed never
 * touches. The copy is a draft with fork provenance: publishing it goes through the usual publish
 * (and, for teams, the eval gate). Allowed whether or not the owner is still around.
 */

export type AdoptError =
  "roster_entry_not_found" | "agent_not_published" | "invalid_agent" | CreateError;
export type AdoptResult =
  | { ok: true; value: { agent: AgentRecord; entry: RosterEntryRecord } }
  | { ok: false; error: AdoptError };

const fail = (error: AdoptError): { ok: false; error: AdoptError } => ({ ok: false, error });

export interface AdoptInput {
  readonly agentId: string;
  /** The adopting admin: creator of a team-owned copy, actor of the audit. */
  readonly userId: string;
  readonly target: RosterTarget;
  /** The team roster's team (target team only). */
  readonly teamId: string | null;
}

export async function adoptEntry(db: KobeDb, input: AdoptInput): Promise<AdoptResult> {
  const run = (tx: KobeTx) => adoptIn(tx, input);
  if (input.target === "site") return db.transaction(run);
  if (input.teamId === null) throw new Error("adopt: a team roster adopt needs a team");
  return withTeam(db, input.teamId, run);
}

async function adoptIn(tx: KobeTx, input: AdoptInput): Promise<AdoptResult> {
  const { target, agentId, teamId } = input;
  await lockRoster(tx, target, teamId);
  const agent = await lockPersonalAgent(tx, agentId);
  if (!agent) return fail("roster_entry_not_found");
  const entry =
    target === "team"
      ? await teamEntry(tx, teamId ?? "", agentId, true)
      : await siteEntry(tx, agentId, true);
  // Only an assigned entry (not a proposal, not removed) is adopted.
  if (!entry || (entry.state !== "active" && entry.state !== "suspended")) {
    return fail("roster_entry_not_found");
  }
  if (agent.currentVersion === null) return fail("agent_not_published");
  const [version] = await tx
    .select({ frontmatter: siteAgentVersions.frontmatter, prompt: siteAgentVersions.prompt })
    .from(siteAgentVersions)
    .where(
      and(
        eq(siteAgentVersions.agentId, agentId),
        eq(siteAgentVersions.version, agent.currentVersion),
      ),
    );
  const definition = version ? validateAgentDefinition(version) : null;
  if (!definition?.ok) return fail("invalid_agent");
  const location: AgentLocation =
    target === "team" ? { scope: "team", teamId: teamId ?? "" } : { scope: "gallery" };
  const created = await insertAgent(tx, location, {
    definition: definition.definition,
    baseSlug: agent.slug,
    ownerUserId: target === "team" ? input.userId : null,
    source: "adopt",
    forkedFrom: agentId,
    forkedFromVersion: agent.currentVersion,
  });
  if (!created.ok) return fail(created.error);
  const now = new Date();
  const removed = await writeEntry(
    tx,
    target,
    teamId,
    agentId,
    { state: "removed", removedAt: now, decidedBy: input.userId, decidedAt: now },
    false,
  );
  await audit(tx, "removed", target, teamId, agent);
  const copy = created.value;
  await recordAudit(tx, {
    action: "agent.adopted",
    teamId: target === "team" ? teamId : null,
    target: {
      agentId: copy.id,
      scope: target === "team" ? "team" : "gallery",
      slug: copy.slug,
      roster: target,
      fromAgentId: agentId,
      fromVersion: agent.currentVersion,
    },
  });
  return { ok: true, value: { agent: copy, entry: removed } };
}
