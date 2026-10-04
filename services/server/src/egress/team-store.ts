import {
  and,
  asc,
  egressDomains,
  eq,
  isSharedHosting,
  notifyEgressChanged,
  teamEgress,
  withTeam,
  type EgressPreset,
  type KobeDb,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * Team egress enablement (spec D6, D28; `/v1/team/egress`): team admins enable domains within the
 * install ceiling. Nothing is enabled by default ("fresh installs reach nothing").
 */
export interface TeamEgressEntry {
  readonly domain: string;
  readonly preset: EgressPreset | null;
  /** In the install ceiling now (enablement only takes effect while it is). */
  readonly in_ceiling: boolean;
  /** Shared hosting / CDN: domain fronting can reach other sites behind it (see ceiling-store). */
  readonly shared_hosting: boolean;
  readonly enabled: boolean;
  readonly enabled_by: string | null;
  readonly enabled_at: string | null;
  /** Injected header names (KOBE-39); values are write-only and never returned. */
  readonly header_names: readonly string[];
  readonly headers_updated_at: string | null;
}

/**
 * Every ceiling domain with the team's choice, plus enabled domains that left the ceiling (shown
 * as suspended). The ceiling is install-wide; the team's rows are read under its RLS.
 */
export async function listTeamEgress(db: KobeDb, teamId: string): Promise<TeamEgressEntry[]> {
  const [ceiling, enabled] = await Promise.all([
    db.select().from(egressDomains).orderBy(asc(egressDomains.domain)),
    // Never the sealed header values: they leave the database only to the egress proxy.
    withTeam(db, teamId, (tx) =>
      tx
        .select({
          domain: teamEgress.domain,
          enabledBy: teamEgress.enabledBy,
          enabledAt: teamEgress.enabledAt,
          headerNames: teamEgress.headerNames,
          headersUpdatedAt: teamEgress.headersUpdatedAt,
        })
        .from(teamEgress)
        .where(eq(teamEgress.teamId, teamId)),
    ),
  ]);
  const byDomain = new Map(enabled.map((r) => [r.domain, r]));
  return ceiling
    .filter((c) => c.inCeiling || byDomain.has(c.domain))
    .map((c) => {
      const e = byDomain.get(c.domain);
      return {
        domain: c.domain,
        preset: c.preset ?? null,
        in_ceiling: c.inCeiling,
        shared_hosting: isSharedHosting(c.domain),
        enabled: e !== undefined,
        enabled_by: e?.enabledBy ?? null,
        enabled_at: e?.enabledAt.toISOString() ?? null,
        header_names: e?.headerNames ?? [],
        headers_updated_at: e?.headersUpdatedAt?.toISOString() ?? null,
      };
    });
}

export type EnableResult = "enabled" | "already_enabled" | "not_in_ceiling";

/** Enables a ceiling domain for the team (no user self-allow: team admins only, at the route). */
export async function enableTeamDomain(
  db: KobeDb,
  teamId: string,
  domain: string,
  userId: string,
): Promise<EnableResult> {
  return withTeam(db, teamId, async (tx) => {
    // FOR SHARE: the ceiling row can't be taken out (or deleted) until this commits.
    const [ceiling] = await tx
      .select({ inCeiling: egressDomains.inCeiling })
      .from(egressDomains)
      .where(eq(egressDomains.domain, domain))
      .for("share");
    if (!ceiling?.inCeiling) return "not_in_ceiling";
    const inserted = await tx
      .insert(teamEgress)
      .values({ teamId, domain, enabledBy: userId })
      .onConflictDoNothing()
      .returning({ domain: teamEgress.domain });
    if (inserted.length === 0) return "already_enabled";
    await notifyEgressChanged(tx, teamId);
    await recordAudit(tx, { action: "egress.domain.enabled", teamId, target: { domain } });
    return "enabled";
  });
}

/** Disables it; false when it wasn't enabled. */
export async function disableTeamDomain(
  db: KobeDb,
  teamId: string,
  domain: string,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const deleted = await tx
      .delete(teamEgress)
      .where(and(eq(teamEgress.teamId, teamId), eq(teamEgress.domain, domain)))
      .returning({ domain: teamEgress.domain });
    if (deleted.length === 0) return false;
    await notifyEgressChanged(tx, teamId);
    await recordAudit(tx, { action: "egress.domain.disabled", teamId, target: { domain } });
    return true;
  });
}
