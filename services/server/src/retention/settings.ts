import {
  RETENTION_MAXIMUM_KEY,
  eq,
  installSettings,
  teamRetention,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import {
  DEFAULT_PERIOD,
  parsePeriod,
  retentionView,
  withinMaximum,
  type RetentionPeriod,
  type RetentionView,
} from "./periods.js";

/**
 * Where the periods live (D6): the install maximum in `install_settings` (install admins), the
 * team's period in `team_retention` (team admins, behind team RLS). Both default to forever.
 */

type Executor = KobeDb | KobeTx;

export async function readMaximum(db: Executor): Promise<RetentionPeriod> {
  const [row] = await db
    .select({ value: installSettings.value })
    .from(installSettings)
    .where(eq(installSettings.key, RETENTION_MAXIMUM_KEY));
  return parsePeriod(row?.value ?? DEFAULT_PERIOD);
}

/** The team's chosen period; call inside the team's `withTeam` transaction. */
export async function readTeamPeriod(tx: KobeTx, teamId: string): Promise<RetentionPeriod> {
  const [row] = await tx
    .select({ period: teamRetention.period })
    .from(teamRetention)
    .where(eq(teamRetention.teamId, teamId));
  return parsePeriod(row?.period ?? DEFAULT_PERIOD);
}

export function readRetention(db: KobeDb, teamId: string): Promise<RetentionView> {
  return withTeam(db, teamId, async (tx) =>
    retentionView(await readTeamPeriod(tx, teamId), await readMaximum(tx)),
  );
}

export type SetTeamPeriodResult =
  | { readonly ok: true; readonly view: RetentionView }
  | { readonly ok: false; readonly error: "exceeds_maximum"; readonly maximum: RetentionPeriod };

/**
 * Sets the team's period (team admins). Refused above the install maximum. Audited
 * (`retention.policy.changed`) when it changes. A concurrent lowering of the maximum can't extend
 * retention: the job always applies the shorter of the two.
 */
export function setTeamPeriod(
  db: KobeDb,
  teamId: string,
  userId: string,
  period: RetentionPeriod,
): Promise<SetTeamPeriodResult> {
  return withTeam(db, teamId, async (tx) => {
    const maximum = await readMaximum(tx);
    if (!withinMaximum(period, maximum)) return { ok: false, error: "exceeds_maximum", maximum };
    const previous = await readTeamPeriod(tx, teamId);
    if (previous !== period) {
      await tx
        .insert(teamRetention)
        .values({ teamId, period, updatedBy: userId })
        .onConflictDoUpdate({
          target: teamRetention.teamId,
          set: { period, updatedBy: userId, updatedAt: new Date() },
        });
      await recordAudit(tx, {
        action: "retention.policy.changed",
        teamId,
        target: { period, previous },
      });
    }
    return { ok: true, view: retentionView(period, maximum) };
  });
}

/**
 * Sets the install maximum (install admins). Lowering it caps every team at once (the nightly job
 * applies the shorter period); team choices are kept, so raising it again restores them.
 */
export function setMaximum(db: KobeDb, maximum: RetentionPeriod): Promise<RetentionPeriod> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ value: installSettings.value })
      .from(installSettings)
      .where(eq(installSettings.key, RETENTION_MAXIMUM_KEY))
      .for("update");
    const previous = parsePeriod(row?.value ?? DEFAULT_PERIOD);
    if (previous === maximum) return maximum;
    await tx
      .insert(installSettings)
      .values({ key: RETENTION_MAXIMUM_KEY, value: maximum })
      .onConflictDoUpdate({
        target: installSettings.key,
        set: { value: maximum, updatedAt: new Date() },
      });
    await recordAudit(tx, {
      action: "retention.maximum.changed",
      target: { maximum, previous },
    });
    return maximum;
  });
}
