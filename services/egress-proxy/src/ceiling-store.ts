import { sql, type KobeDb } from "@kobe/db";
import type { CeilingPattern } from "./allowlist.js";

/**
 * The site ceiling with each pattern's internal flag (EA4, KOBE-603): one query, so a pattern and
 * its flag are always read together. `egress_domains.internal` comes with KOBE-602's migration;
 * the flag is read through `to_jsonb(row)` so a database without the column yet reads every
 * pattern as not internal (fails closed) instead of failing the whole ceiling.
 */
export async function loadEgressCeilingWithInternal(db: KobeDb): Promise<CeilingPattern[]> {
  const res = await db.execute<{ domain: string; internal: boolean }>(sql`
    SELECT d.domain, COALESCE((to_jsonb(d) ->> 'internal')::boolean, false) AS internal
      FROM egress_domains d
     WHERE d.in_ceiling`);
  return res.rows.map((r) => ({ domain: r.domain, internal: r.internal === true }));
}
