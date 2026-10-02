import { sql, type KobeDb } from "@kobe/db";

export interface RateLimitRule {
  readonly windowMs: number;
  readonly max: number;
}

/**
 * Counts one hit against `key` in a fixed window and says whether it is within the limit. Shares
 * Postgres' `rate_limits` table with Better Auth (keys here start with "kobe:"), so every replica
 * sees the same counters. One atomic upsert; no read-modify-write race.
 */
export async function hitRateLimit(
  db: KobeDb,
  key: string,
  rule: RateLimitRule,
  now = Date.now(),
): Promise<boolean> {
  const stale = now - rule.windowMs;
  const result = await db.execute<{ count: number }>(sql`
    INSERT INTO rate_limits (key, count, last_request) VALUES (${`kobe:${key}`}, 1, ${now})
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.last_request < ${stale} THEN 1 ELSE rate_limits.count + 1 END,
      last_request = CASE WHEN rate_limits.last_request < ${stale} THEN ${now}
                          ELSE rate_limits.last_request END
    RETURNING count`);
  return (result.rows[0]?.count ?? Number.POSITIVE_INFINITY) <= rule.max;
}
