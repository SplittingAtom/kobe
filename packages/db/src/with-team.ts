import { sql } from "drizzle-orm";
import { z } from "zod";
import type { KobeDb, KobeTx } from "./client.js";
import { TEAM_ID_SETTING } from "./settings.js";

const teamIdSchema = z.uuid({ error: "team id must be a UUID" });

/**
 * Runs `fn` in a transaction scoped to one team: `set_config(kobe.team_id, id, true)` is the
 * parameterizable form of `SET LOCAL`, so the setting ends with the transaction and never leaks to
 * the next user of a pooled connection. RLS policies read it; outside withTeam they match nothing.
 */
export async function withTeam<T>(
  db: KobeDb,
  teamId: string,
  fn: (tx: KobeTx) => Promise<T>,
): Promise<T> {
  const parsed = teamIdSchema.safeParse(teamId);
  if (!parsed.success) {
    throw new Error(
      `withTeam: invalid team id ${JSON.stringify(teamId.slice(0, 64))} (must be a UUID)`,
    );
  }
  return db.transaction(async (tx) => {
    // A transaction-local setting survives RELEASE SAVEPOINT, so a nested withTeam would silently
    // switch the outer transaction to another team. Refuse instead.
    const current = await tx.execute<{ team: string | null }>(
      sql`SELECT NULLIF(current_setting(${TEAM_ID_SETTING}, true), '') AS team`,
    );
    if (current.rows[0]?.team) throw new Error("withTeam: nested withTeam is not allowed");
    await tx.execute(sql`SELECT set_config(${TEAM_ID_SETTING}, ${parsed.data}, true)`);
    return fn(tx);
  });
}
