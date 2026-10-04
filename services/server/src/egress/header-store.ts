import {
  and,
  eq,
  isNotNull,
  notifyEgressChanged,
  openHeaders,
  sealHeaders,
  teams,
  sql,
  teamEgress,
  withTeam,
  type InjectedHeader,
  type KobeDb,
  type SecretBox,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Per-team header injection (spec D28, KOBE-39): a team admin sets the headers the egress proxy adds
 * to the team's sandbox requests for one enabled domain (e.g. a private package index's token).
 * Values are sealed here with the `egress-headers` secret (team and domain as context) and are
 * write-only: no API returns them, the audit records names only, and only the egress proxy opens
 * them. Every change NOTIFYs the proxies (team hint), so new requests use it at once.
 */
export type HeaderResult = "set" | "cleared" | "not_enabled" | "none";

export async function setTeamDomainHeaders(
  db: KobeDb,
  box: SecretBox,
  input: {
    readonly teamId: string;
    readonly domain: string;
    readonly userId: string;
    readonly headers: readonly InjectedHeader[];
  },
): Promise<HeaderResult> {
  const { teamId, domain } = input;
  return withTeam(db, teamId, async (tx) => {
    const updated = await tx
      .update(teamEgress)
      .set({
        headerNames: input.headers.map((h) => h.name),
        headersSealed: sealHeaders(box, teamId, domain, input.headers),
        headersUpdatedBy: input.userId,
        headersUpdatedAt: sql`now()`,
      })
      .where(and(eq(teamEgress.teamId, teamId), eq(teamEgress.domain, domain)))
      .returning({ domain: teamEgress.domain });
    if (updated.length === 0) return "not_enabled";
    await notifyEgressChanged(tx, teamId);
    await recordAudit(tx, {
      action: "egress.header.set",
      teamId,
      target: { domain, headerNames: input.headers.map((h) => h.name) },
    });
    return "set";
  });
}

export async function clearTeamDomainHeaders(
  db: KobeDb,
  input: { readonly teamId: string; readonly domain: string; readonly userId: string },
): Promise<HeaderResult> {
  const { teamId, domain } = input;
  return withTeam(db, teamId, async (tx) => {
    const [row] = await tx
      .select({ sealed: teamEgress.headersSealed })
      .from(teamEgress)
      .where(and(eq(teamEgress.teamId, teamId), eq(teamEgress.domain, domain)))
      .for("update");
    if (!row) return "not_enabled";
    if (row.sealed === null) return "none";
    await tx
      .update(teamEgress)
      .set({
        headerNames: [],
        headersSealed: null,
        headersUpdatedBy: input.userId,
        headersUpdatedAt: sql`now()`,
      })
      .where(and(eq(teamEgress.teamId, teamId), eq(teamEgress.domain, domain)));
    await notifyEgressChanged(tx, teamId);
    await recordAudit(tx, { action: "egress.header.cleared", teamId, target: { domain } });
    return "cleared";
  });
}

/**
 * Re-seals injected header values that a previous `KOBE_EGRESS_HEADER_SECRET` sealed (rotation:
 * the box holds the current secret first, the previous one after it). Values are opened and sealed
 * again in place, never logged; once every row uses the current secret the previous one can be
 * dropped. Returns how many domains were re-sealed.
 */
export async function resealTeamHeaders(db: KobeDb, box: SecretBox): Promise<number> {
  let resealed = 0;
  for (const { id: teamId } of await db.select({ id: teams.id }).from(teams)) {
    resealed += await withTeam(db, teamId, async (tx) => {
      const rows = await tx
        .select({ domain: teamEgress.domain, sealed: teamEgress.headersSealed })
        .from(teamEgress)
        .where(and(eq(teamEgress.teamId, teamId), isNotNull(teamEgress.headersSealed)))
        .for("update");
      let n = 0;
      for (const row of rows) {
        if (row.sealed === null || box.isCurrent(row.sealed)) continue;
        const headers = openHeaders(box, teamId, row.domain, row.sealed);
        await tx
          .update(teamEgress)
          .set({ headersSealed: sealHeaders(box, teamId, row.domain, headers) })
          .where(and(eq(teamEgress.teamId, teamId), eq(teamEgress.domain, row.domain)));
        n++;
      }
      return n;
    });
  }
  return resealed;
}
