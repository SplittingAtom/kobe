import { sql } from "drizzle-orm";
import type { KobeDb } from "../client.js";
import { USAGE_MODEL_MAX_CHARS, type UsageRoute, type UsageSource } from "../schema/usage.js";
import { withTeam } from "../with-team.js";

/**
 * One forwarded model call as the model-gateway shim measured it (KOBE-43). `runId` is the
 * advisory `x-kobe-run-id` the shim verified as an active run leased to the sandbox; the thread
 * and agent are looked up from it when the row is written.
 */
export interface ModelUsageRecord {
  readonly teamId: string;
  readonly userId: string;
  readonly sandboxId: string;
  readonly runId: string | undefined;
  readonly at: Date;
  readonly route: UsageRoute;
  readonly model: string;
  readonly status: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly usageSource: UsageSource;
  readonly durationMs: number;
  readonly ttfbMs: number | undefined;
  readonly aborted: boolean;
}

const MAX_TOKENS = 2_000_000_000;
const tokens = (n: number) => Math.min(MAX_TOKENS, Math.max(0, Math.round(n)));
const millis = (n: number) => Math.min(MAX_TOKENS, Math.max(0, Math.round(n)));

/**
 * The gateway name of a catalog entry's model, as SQL (`gatewayProviderName` + `/` + model): the
 * same mapping the shim enforces.
 */
const GATEWAY_MODEL_SQL = sql.raw(
  `(CASE WHEN p.kind = 'openai_compatible' THEN 'kobe-' || p.id ELSE p.kind::text END) || '/' || c.model`,
);

/**
 * Writes usage rows, one transaction per team (RLS), with each call's cost at the catalog's
 * current prices. Several aliases may name one model: the highest price of each kind counts (a
 * budget never under-counts). A model without both an input and an output price has no cost.
 */
export async function recordModelUsage(
  db: KobeDb,
  records: readonly ModelUsageRecord[],
): Promise<number> {
  const byTeam = new Map<string, ModelUsageRecord[]>();
  for (const r of records) byTeam.set(r.teamId, [...(byTeam.get(r.teamId) ?? []), r]);
  let written = 0;
  for (const [teamId, rows] of byTeam) {
    const payload = rows.map((r) => ({
      user_id: r.userId,
      sandbox_id: r.sandboxId,
      run_id: r.runId ?? null,
      at: r.at.toISOString(),
      route: r.route,
      model: r.model.slice(0, USAGE_MODEL_MAX_CHARS),
      status: r.status,
      input_tokens: tokens(r.inputTokens),
      output_tokens: tokens(r.outputTokens),
      cache_read_tokens: tokens(r.cacheReadTokens),
      cache_write_tokens: tokens(r.cacheWriteTokens),
      usage_source: r.usageSource,
      duration_ms: millis(r.durationMs),
      ttfb_ms: r.ttfbMs === undefined ? null : millis(r.ttfbMs),
      aborted: r.aborted,
    }));
    written += await withTeam(db, teamId, async (tx) => {
      const res = await tx.execute(sql`
        INSERT INTO run_usage (team_id, at, user_id, sandbox_id, run_id, thread_id, agent_id, route,
          model, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          usage_source, cost_usd, duration_ms, ttfb_ms, aborted)
        SELECT ${teamId}::uuid, v.at, v.user_id, v.sandbox_id, v.run_id, r.thread_id, t.agent_id,
               v.route, v.model, v.status, v.input_tokens, v.output_tokens, v.cache_read_tokens,
               v.cache_write_tokens, v.usage_source,
               CASE WHEN price.input IS NULL OR price.output IS NULL THEN NULL ELSE
                 (v.input_tokens * price.input + v.output_tokens * price.output
                  + v.cache_read_tokens * COALESCE(price.cache_read, price.input)
                  + v.cache_write_tokens * COALESCE(price.cache_write, price.input)) / 1000000
               END,
               v.duration_ms, v.ttfb_ms, v.aborted
          FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS v(
                 user_id uuid, sandbox_id uuid, run_id uuid, at timestamptz, route text,
                 model text, status smallint, input_tokens integer, output_tokens integer,
                 cache_read_tokens integer, cache_write_tokens integer, usage_source text,
                 duration_ms integer, ttfb_ms integer, aborted boolean)
          LEFT JOIN runs r ON r.team_id = ${teamId}::uuid AND r.id = v.run_id
          LEFT JOIN threads t ON t.team_id = ${teamId}::uuid AND t.id = r.thread_id
          LEFT JOIN LATERAL (
            SELECT max(c.input_usd_per_mtok) AS input, max(c.output_usd_per_mtok) AS output,
                   max(c.cache_read_usd_per_mtok) AS cache_read,
                   max(c.cache_write_usd_per_mtok) AS cache_write
              FROM model_catalog c JOIN model_providers p ON p.id = c.provider_id
             WHERE ${GATEWAY_MODEL_SQL} = v.model
          ) price ON true`);
      return res.rowCount ?? 0;
    });
  }
  return written;
}
