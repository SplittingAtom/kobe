import {
  agentTransfers,
  and,
  eq,
  inArray,
  isNull,
  or,
  scanTeams,
  siteAgents,
  sql,
  teamMembers,
  users,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { AgentTransfer, AgentTransferList, AgentTransferView } from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import type { RosterActor } from "./access.js";
import { AGENT_CAPS, lockKey } from "./store.js";

/**
 * Transfer of a personal agent to another member of the same team (KOBE-568, agents-roster AR10,
 * §6.8): the owner offers it, the recipient accepts (or declines), the owner may cancel. On accept
 * the agent keeps its id, so its roster entries keep their rows and threads keep their pins; only
 * `site_agents.owner_user_id` moves. A bound agent goes only to a member of its bound team.
 *
 * Offers live in the team table `agent_transfers` (RLS): every query runs inside `withTeam()` of
 * the offer's team (or `scanTeams` to find one) and still states `team_id`; at most one pending
 * offer per agent site-wide. Decided offers stay as history (accepted, declined, cancelled).
 */

export type TransferError =
  | "agent_not_found"
  | "transfer_not_found"
  | "transfer_recipient_invalid"
  | "agent_bound_to_team"
  | "agent_archived"
  | "invalid_transition"
  | "slug_taken"
  | "limit_reached";
export type TransferResult<T> = { ok: true; value: T } | { ok: false; error: TransferError };
const fail = (error: TransferError): { ok: false; error: TransferError } => ({ ok: false, error });

interface OwnedAgent {
  readonly id: string;
  readonly slug: string;
  readonly ownerUserId: string;
  readonly boundTeamId: string | null;
  readonly archivedAt: Date | null;
}

/** The personal agent, locked for the rest of `tx` (`FOR UPDATE`: ownership is changing). */
async function lockOwned(tx: KobeTx, agentId: string): Promise<OwnedAgent | null> {
  const [row] = await tx
    .select({
      id: siteAgents.id,
      slug: siteAgents.slug,
      ownerUserId: siteAgents.ownerUserId,
      boundTeamId: siteAgents.boundTeamId,
      archivedAt: siteAgents.archivedAt,
    })
    .from(siteAgents)
    .where(and(eq(siteAgents.id, agentId), eq(siteAgents.scope, "personal")))
    .for("update");
  return row?.ownerUserId ? { ...row, ownerUserId: row.ownerUserId } : null;
}

const OFFER = {
  id: agentTransfers.id,
  agentId: agentTransfers.siteAgentId,
  fromUserId: agentTransfers.fromUserId,
  toUserId: agentTransfers.toUserId,
  teamId: agentTransfers.teamId,
  createdAt: agentTransfers.createdAt,
};
type OfferRow = {
  id: string;
  agentId: string;
  fromUserId: string;
  toUserId: string;
  teamId: string;
  createdAt: Date;
};

const view = (r: OfferRow): AgentTransfer => ({
  agentId: r.agentId,
  fromUserId: r.fromUserId,
  toUserId: r.toUserId,
  teamId: r.teamId,
  requestedAt: r.createdAt.toISOString(),
});

/** One team's pending offer of the agent. Call inside `withTeam(db, teamId)`. */
async function pendingIn(tx: KobeTx, teamId: string, agentId: string, lock = false) {
  const query = tx
    .select(OFFER)
    .from(agentTransfers)
    .where(
      and(
        eq(agentTransfers.teamId, teamId),
        eq(agentTransfers.siteAgentId, agentId),
        eq(agentTransfers.state, "pending"),
      ),
    );
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

/** The agent's pending transfer, in whichever team it was offered. Not inside a team transaction. */
export async function pendingTransfer(db: KobeDb, agentId: string): Promise<AgentTransfer | null> {
  const [row] = await scanTeams(db, "pendingTransfer", (tx, team) =>
    pendingIn(tx, team.id, agentId).then((r) => r ?? undefined),
  );
  return row ? view(row) : null;
}

/** An active (not deactivated) member of `teamId`. Call inside `withTeam(db, teamId)`. */
async function activeMember(tx: KobeTx, teamId: string, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(
      and(
        eq(teamMembers.teamId, teamId),
        eq(teamMembers.userId, userId),
        isNull(users.deactivatedAt),
      ),
    );
  return row !== undefined;
}

const ref = (agent: OwnedAgent) => ({
  agentId: agent.id,
  scope: "personal" as const,
  slug: agent.slug,
});

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.cause?.code ?? e?.code;
}

/**
 * `POST /v1/agents/:id/transfer`: the owner offers their agent to another active member of the
 * active team. A new offer replaces a pending one in this team (cancelled); one pending in another
 * team must be cancelled first (`409 invalid_transition`).
 */
export async function requestTransfer(
  db: KobeDb,
  actor: RosterActor,
  agentId: string,
  toUserId: string,
): Promise<TransferResult<AgentTransfer>> {
  try {
    return await withTeam(db, actor.teamId, async (tx) => {
      const agent = await lockOwned(tx, agentId);
      if (!agent || agent.ownerUserId !== actor.userId) return fail("agent_not_found");
      // An archived agent is retired (KOBE-46): unarchive it before handing it over.
      if (agent.archivedAt !== null) return fail("agent_archived");
      if (agent.boundTeamId !== null && agent.boundTeamId !== actor.teamId) {
        return fail("agent_bound_to_team");
      }
      if (toUserId === actor.userId || !(await activeMember(tx, actor.teamId, toUserId))) {
        return fail("transfer_recipient_invalid");
      }
      const previous = await pendingIn(tx, actor.teamId, agentId, true);
      if (previous) {
        await tx
          .update(agentTransfers)
          .set({ state: "cancelled", decidedAt: new Date() })
          .where(and(eq(agentTransfers.teamId, actor.teamId), eq(agentTransfers.id, previous.id)));
      }
      const [row] = await tx
        .insert(agentTransfers)
        .values({ teamId: actor.teamId, siteAgentId: agentId, fromUserId: actor.userId, toUserId })
        .returning(OFFER);
      if (!row) throw new Error("agent transfer insert returned no row");
      await recordAudit(tx, {
        action: "agent.transfer.requested",
        teamId: actor.teamId,
        target: { ...ref(agent), fromUserId: actor.userId, toUserId },
      });
      return { ok: true, value: view(row) };
    });
  } catch (err) {
    // The one pending offer per agent is in another team.
    if (pgCode(err) === "23505") return fail("invalid_transition");
    throw err;
  }
}

/**
 * Runs `fn` in the offer's team with the agent and the offer locked; `transfer_not_found` unless
 * `userId` is a party (`as`). A stale offer (the agent changed owner) is cancelled.
 */
async function withOffer<T>(
  db: KobeDb,
  agentId: string,
  userId: string,
  as: "either" | "recipient",
  fn: (tx: KobeTx, agent: OwnedAgent, offer: OfferRow) => Promise<TransferResult<T>>,
): Promise<TransferResult<T>> {
  const party = (o: { fromUserId: string; toUserId: string }) =>
    o.toUserId === userId || (as === "either" && o.fromUserId === userId);
  const seen = await pendingTransfer(db, agentId);
  if (!seen || !party(seen)) return fail("transfer_not_found");
  return withTeam(db, seen.teamId, async (tx) => {
    const agent = await lockOwned(tx, agentId);
    const offer = await pendingIn(tx, seen.teamId, agentId, true);
    if (!offer || !party(offer)) return fail("transfer_not_found");
    if (!agent || agent.ownerUserId !== offer.fromUserId) {
      await decide(tx, offer, "cancelled");
      return fail("transfer_not_found");
    }
    return fn(tx, agent, offer);
  });
}

const decide = (tx: KobeTx, offer: OfferRow, state: "accepted" | "declined" | "cancelled") =>
  tx
    .update(agentTransfers)
    .set({ state, decidedAt: new Date() })
    .where(and(eq(agentTransfers.teamId, offer.teamId), eq(agentTransfers.id, offer.id)));

/** `DELETE /v1/agents/:id/transfer`: the owner cancels, or the recipient declines. */
export async function cancelTransfer(
  db: KobeDb,
  userId: string,
  agentId: string,
): Promise<TransferResult<AgentTransfer>> {
  return withOffer(db, agentId, userId, "either", async (tx, agent, offer) => {
    const byOwner = offer.fromUserId === userId;
    await decide(tx, offer, byOwner ? "cancelled" : "declined");
    await recordAudit(tx, {
      action: "agent.transfer.cancelled",
      teamId: offer.teamId,
      target: {
        ...ref(agent),
        fromUserId: offer.fromUserId,
        toUserId: offer.toUserId,
        by: byOwner ? "owner" : "recipient",
      },
    });
    return { ok: true, value: view(offer) };
  });
}

/**
 * `POST /v1/agents/:id/transfer/accept`: the recipient, still an active member of the offer's team
 * (and of the bound team), becomes the owner. Their slug and agent cap apply, serialized with their
 * own creates.
 */
export async function acceptTransfer(
  db: KobeDb,
  userId: string,
  agentId: string,
): Promise<TransferResult<AgentTransfer>> {
  return withOffer(db, agentId, userId, "recipient", async (tx, agent, offer) => {
    if (agent.archivedAt !== null) return fail("agent_archived");
    if (agent.boundTeamId !== null && agent.boundTeamId !== offer.teamId) {
      return fail("agent_bound_to_team");
    }
    if (!(await activeMember(tx, offer.teamId, userId))) return fail("transfer_recipient_invalid");
    const location = { scope: "personal" as const, ownerUserId: userId };
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(location)}, 0))`);
    const theirs = await tx
      .select({ slug: siteAgents.slug, archivedAt: siteAgents.archivedAt })
      .from(siteAgents)
      .where(and(eq(siteAgents.scope, "personal"), eq(siteAgents.ownerUserId, userId)));
    if (theirs.some((a) => a.slug === agent.slug)) return fail("slug_taken");
    if (theirs.filter((a) => a.archivedAt === null).length >= AGENT_CAPS.personal) {
      return fail("limit_reached");
    }
    await tx
      .update(siteAgents)
      .set({ ownerUserId: userId, updatedAt: new Date() })
      .where(and(eq(siteAgents.id, agentId), eq(siteAgents.scope, "personal")));
    await decide(tx, offer, "accepted");
    await recordAudit(tx, {
      action: "agent.transferred",
      teamId: offer.teamId,
      target: { ...ref(agent), fromUserId: offer.fromUserId, toUserId: userId },
    });
    return { ok: true, value: view(offer) };
  });
}

/** `GET /v1/agents/transfers`: the caller's pending offers, both ways, with slug and name. */
export async function listTransfers(db: KobeDb, userId: string): Promise<AgentTransferList> {
  const perTeam = await scanTeams(db, "listTransfers", async (tx, team) => {
    const rows = await tx
      .select(OFFER)
      .from(agentTransfers)
      .where(
        and(
          eq(agentTransfers.teamId, team.id),
          eq(agentTransfers.state, "pending"),
          or(eq(agentTransfers.fromUserId, userId), eq(agentTransfers.toUserId, userId)),
        ),
      );
    return rows.length > 0 ? rows : undefined;
  });
  const mine = perTeam.flat();
  if (mine.length === 0) return { incoming: [], outgoing: [] };
  const agents = await db
    .select({
      id: siteAgents.id,
      slug: siteAgents.slug,
      ownerUserId: siteAgents.ownerUserId,
      frontmatter: siteAgents.frontmatter,
    })
    .from(siteAgents)
    .where(
      and(
        eq(siteAgents.scope, "personal"),
        inArray(
          siteAgents.id,
          mine.map((t) => t.agentId),
        ),
      ),
    );
  const byId = new Map(agents.map((a) => [a.id, a]));
  const views: AgentTransferView[] = [];
  for (const t of mine) {
    const agent = byId.get(t.agentId);
    // A stale offer (the agent changed owner) is not shown; accept or cancel drops it.
    if (!agent || agent.ownerUserId !== t.fromUserId) continue;
    const name = typeof agent.frontmatter.name === "string" ? agent.frontmatter.name : agent.slug;
    views.push({ ...view(t), slug: agent.slug, name });
  }
  const byTime = (a: AgentTransferView, b: AgentTransferView) =>
    a.requestedAt.localeCompare(b.requestedAt);
  return {
    incoming: views.filter((t) => t.toUserId === userId).sort(byTime),
    outgoing: views.filter((t) => t.fromUserId === userId).sort(byTime),
  };
}
