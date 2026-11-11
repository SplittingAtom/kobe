import { KOBE_BUILTIN_CONNECTOR_ID, sql, type KobeDb } from "@kobe/db";

/**
 * Per-person Kobe admin limits (KOBE-619, spec §6): admin reads per minute and admin writes per
 * hour, site settings with defaults 60 and 30. Counted from the person's allowed `mcp.tool_call`
 * rows for the built-in connector in the audit log, so the limit holds across server replicas and
 * restarts; the window is found by `at` (indexed) and the person's rows by `(actor_id, seq)`.
 * Calls of the docs tools (`mcp__<kobe>__docs_*`, KOBE-620) are not admin calls and never count.
 */
export const KOBE_READS_PER_MINUTE_KEY = "kobe_mcp.reads_per_minute";
export const KOBE_WRITES_PER_HOUR_KEY = "kobe_mcp.writes_per_hour";
export const KOBE_READS_PER_MINUTE_DEFAULT = 60;
export const KOBE_WRITES_PER_HOUR_DEFAULT = 30;
const LIMIT_MAX = 10_000;

const limitOf = (value: string | null | undefined, fallback: number): number => {
  if (value === null || value === undefined || !/^[0-9]{1,5}$/.test(value)) return fallback;
  return Math.min(Math.max(Number(value), 1), LIMIT_MAX);
};

/** Whether the person may make one more admin read (or write) now. Fails closed on errors. */
export async function withinKobeLimit(
  db: KobeDb,
  userId: string,
  kind: "read" | "write",
): Promise<boolean> {
  const key = kind === "read" ? KOBE_READS_PER_MINUTE_KEY : KOBE_WRITES_PER_HOUR_KEY;
  const window = kind === "read" ? "1 minute" : "1 hour";
  const res = await db.execute<{ used: number; limit_value: string | null }>(sql`
    WITH boundary AS (
      SELECT min(a.seq) AS seq FROM public.audit_log a
       WHERE a.at > now() - ${window}::interval)
    SELECT
      (SELECT count(*)::int FROM public.audit_log a, boundary b
        WHERE a.actor_id = ${userId} AND a.seq >= b.seq
          AND a.action = 'mcp.tool_call'
          AND a.target ->> 'connectorId' = ${KOBE_BUILTIN_CONNECTOR_ID}
          AND a.target ->> 'decision' = 'allowed'
          -- The docs tools (KOBE-620) are no admin reads: they never count.
          AND a.target ->> 'tool' !~ '__docs_[a-z_]+$'
          AND (a.target ->> 'risk' = 'read') = ${kind === "read"}) AS used,
      (SELECT s.value FROM public.site_settings s WHERE s.key = ${key}) AS limit_value`);
  const row = res.rows[0];
  if (row === undefined) return false;
  const limit = limitOf(
    row.limit_value,
    kind === "read" ? KOBE_READS_PER_MINUTE_DEFAULT : KOBE_WRITES_PER_HOUR_DEFAULT,
  );
  return row.used < limit;
}
