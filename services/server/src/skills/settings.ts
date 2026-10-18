import { eq, teamSkillSettings, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../audit/record.js";

/**
 * The team's skill switches (KOBE-80, D22; SK25): members' personal skills can be left out of the
 * team's runs, and the catalog switches "Members may add catalog skills for themselves" and
 * "Builders may install catalog skills" (both on by default). No row means the defaults.
 */

export interface CatalogSwitches {
  readonly membersMayAdd: boolean;
  readonly buildersMayInstall: boolean;
}

export async function readCatalogSwitches(tx: KobeTx, teamId: string): Promise<CatalogSwitches> {
  const [row] = await tx
    .select({
      membersMayAdd: teamSkillSettings.membersMayAddCatalog,
      buildersMayInstall: teamSkillSettings.buildersMayInstallCatalog,
    })
    .from(teamSkillSettings)
    .where(eq(teamSkillSettings.teamId, teamId));
  return row ?? { membersMayAdd: true, buildersMayInstall: true };
}

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

export function getCatalogSwitches(db: KobeDb, teamId: string): Promise<CatalogSwitches> {
  return withTeam(db, teamId, (tx) => readCatalogSwitches(tx, teamId));
}

/**
 * Changes the catalog switches given (a Team admin's act, SK25) and audits the ones that changed;
 * returns the values in force. A team with no settings row gets one (the personal switch stays
 * at its default, off).
 */
export function setCatalogSwitches(
  db: KobeDb,
  teamId: string,
  userId: string,
  change: Partial<CatalogSwitches>,
): Promise<CatalogSwitches> {
  return withTeam(db, teamId, async (tx) => {
    const before = await readCatalogSwitches(tx, teamId);
    const after = { ...before, ...change };
    const changed = {
      ...(after.membersMayAdd !== before.membersMayAdd
        ? { membersMayAddCatalog: after.membersMayAdd }
        : {}),
      ...(after.buildersMayInstall !== before.buildersMayInstall
        ? { buildersMayInstallCatalog: after.buildersMayInstall }
        : {}),
    };
    if (Object.keys(changed).length === 0) return before;
    const values = {
      membersMayAddCatalog: after.membersMayAdd,
      buildersMayInstallCatalog: after.buildersMayInstall,
      updatedBy: userId,
    };
    await tx
      .insert(teamSkillSettings)
      .values({ teamId, ...values })
      .onConflictDoUpdate({
        target: teamSkillSettings.teamId,
        set: { ...values, updatedAt: new Date() },
      });
    await recordAudit(tx, { action: "skill.catalog_switches.changed", teamId, target: changed });
    return after;
  });
}
