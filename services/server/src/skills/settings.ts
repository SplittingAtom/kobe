import { eq, teamSkillSettings, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * The team's skill switches (KOBE-80, D22). Today one: members' personal skills can be left out of
 * the team's runs. No row means the default, personal skills allowed.
 */

export async function readPersonalSkillsDisabled(tx: KobeTx, teamId: string): Promise<boolean> {
  const [row] = await tx
    .select({ disabled: teamSkillSettings.personalSkillsDisabled })
    .from(teamSkillSettings)
    .where(eq(teamSkillSettings.teamId, teamId));
  return row?.disabled ?? false;
}

export function getPersonalSkillsDisabled(db: KobeDb, teamId: string): Promise<boolean> {
  return withTeam(db, teamId, (tx) => readPersonalSkillsDisabled(tx, teamId));
}

/** Sets the switch and audits a real change; returns the value in force. */
export function setPersonalSkillsDisabled(
  db: KobeDb,
  teamId: string,
  userId: string,
  disabled: boolean,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    if ((await readPersonalSkillsDisabled(tx, teamId)) === disabled) return disabled;
    await tx
      .insert(teamSkillSettings)
      .values({ teamId, personalSkillsDisabled: disabled, updatedBy: userId })
      .onConflictDoUpdate({
        target: teamSkillSettings.teamId,
        set: { personalSkillsDisabled: disabled, updatedBy: userId, updatedAt: new Date() },
      });
    await recordAudit(tx, {
      action: "skill.personal_switch.changed",
      teamId,
      target: { disabled },
    });
    return disabled;
  });
}
