import { asc, sql } from "drizzle-orm";
import type { KobeDb, KobeTx } from "./client.js";
import { teams } from "./schema/index.js";
import { TEAM_ID_SETTING } from "./settings.js";

export interface ScannedTeam {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

/**
 * Visits every team in one transaction, setting `kobe.team_id` transaction-locally for each, so a
 * per-user question ("which teams am I in?", "which teams invited me?") can be answered while team
 * tables stay behind their one canonical RLS policy (no bypass, no SECURITY DEFINER). Teams are
 * visited by name; `visit` returns a result to keep or undefined. Cost: one query per team.
 */
export async function scanTeams<T>(
  db: KobeDb,
  caller: string,
  visit: (tx: KobeTx, team: ScannedTeam) => Promise<T | undefined>,
): Promise<T[]> {
  return db.transaction(async (tx) => {
    const current = await tx.execute<{ team: string | null }>(
      sql`SELECT NULLIF(current_setting(${TEAM_ID_SETTING}, true), '') AS team`,
    );
    if (current.rows[0]?.team) {
      throw new Error(`${caller}: cannot run inside a team transaction`);
    }
    const all = await tx
      .select({ id: teams.id, slug: teams.slug, name: teams.name })
      .from(teams)
      .orderBy(asc(teams.name), asc(teams.slug));
    const results: T[] = [];
    for (const team of all) {
      await tx.execute(sql`SELECT set_config(${TEAM_ID_SETTING}, ${team.id}, true)`);
      const result = await visit(tx, team);
      if (result !== undefined) results.push(result);
    }
    // Savepoints keep transaction-local settings; clear it so nothing downstream inherits a team.
    await tx.execute(sql`SELECT set_config(${TEAM_ID_SETTING}, '', true)`);
    return results;
  });
}
