import { sql, type KobeTx } from "@kobe/db";

/**
 * The team installed a catalog skill (KOBE-338 review M3, D1): the install governs from now on.
 * Members' own adds of it become their "on" choice for the install (they keep the skill, at the
 * team's version and pin), and members' Request for team of it is answered (the rows go; the
 * audit log keeps who asked). Called inside the install's transaction, under its install lock.
 */
export async function skillInstallAnswers(
  tx: KobeTx,
  teamId: string,
  skillId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE member_skill_enablements
       SET version_id = NULL, pin_mode = NULL, enabled = true, updated_at = now()
     WHERE team_id = ${teamId} AND catalog_skill_id = ${skillId} AND version_id IS NOT NULL`);
  await tx.execute(sql`
    DELETE FROM team_skill_requests WHERE team_id = ${teamId} AND skill_id = ${skillId}`);
}
