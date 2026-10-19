import { sql, type KobeTx } from "@kobe/db";
import { toolInputSchema } from "@kobe/protocol";
import { appInputDigest, pinnedInputSchema } from "./input-canonical.js";

/**
 * Claims stored MCP App results for a run's tool results (KOBE-438, spec MA10). mcp-proxy cannot
 * tell which of Pi's tool calls it serves, so its report is stored unclaimed under the run, the
 * Pi tool name and the input digest its capture ticket names. When the run's `tool.result`
 * arrives (always after the report: the proxy reports before Pi gets the result), the oldest
 * unclaimed row with the same run, tool and input digest is given the call's `tool_call_id`, and
 * the event gets the `app` marker. The marker is the server's own: nothing the sandbox sends can
 * set it (the translator builds `tool.result` itself).
 *
 * Exact or nothing (review LOW-1): a call's own report always lands before its tool.result, so
 * exactly one candidate is that call's result. With two or more (identical calls in parallel),
 * the reports' order need not be Pi's, so none is claimed and the cards stay text; the rows are
 * dropped when the run ends (0156).
 */
interface Event {
  readonly type: string;
  readonly payload: unknown;
}

interface ToolResultPayload {
  readonly tool_call_id: string;
  readonly tool: string;
  readonly is_error: boolean;
}

const isMcpResult = (e: Event): e is { type: string; payload: ToolResultPayload } => {
  const p = e.payload as Partial<ToolResultPayload> | null;
  return (
    e.type === "tool.result" &&
    typeof p?.tool === "string" &&
    p.tool.startsWith("mcp__") &&
    p.is_error === false &&
    typeof p.tool_call_id === "string"
  );
};

/** Each tool call's input: from this batch's `tool.call`, else the run's stored one. */
async function inputsOf(
  tx: KobeTx,
  teamId: string,
  runId: string,
  events: readonly Event[],
  ids: readonly string[],
): Promise<Map<string, unknown>> {
  const found = new Map<string, unknown>();
  for (const e of events) {
    const p = e.payload as { tool_call_id?: unknown; input?: unknown } | null;
    if (e.type === "tool.call" && typeof p?.tool_call_id === "string") {
      found.set(p.tool_call_id, p.input);
    }
  }
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    const res = await tx.execute<{ id: string; input: unknown }>(sql`
      SELECT payload->>'tool_call_id' AS id, payload->'input' AS input FROM run_events
       WHERE team_id = ${teamId} AND run_id = ${runId} AND type = 'tool.call'
         AND payload->>'tool_call_id' IN (${sql.join(
           missing.map((id) => sql`${id}`),
           sql`, `,
         )})`);
    for (const r of res.rows) if (!found.has(r.id)) found.set(r.id, r.input);
  }
  return found;
}

export async function claimAppResultsInTx(
  tx: KobeTx,
  teamId: string,
  runId: string,
  events: readonly Event[],
): Promise<Event[]> {
  const results = events.filter(isMcpResult);
  if (results.length === 0) return [...events];
  const pending = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM thread_app_results
     WHERE team_id = ${teamId} AND run_id = ${runId} AND tool_call_id IS NULL AND entry_id IS NULL`);
  if ((pending.rows[0]?.n ?? 0) === 0) return [...events];
  const inputs = await inputsOf(
    tx,
    teamId,
    runId,
    events,
    results.map((e) => e.payload.tool_call_id),
  );
  const marked = new Map<Event, Record<string, string>>();
  for (const event of results) {
    const input = toolInputSchema.safeParse(inputs.get(event.payload.tool_call_id));
    if (!input.success || "kobe_omitted" in input.data) continue;
    // The canonical digest against the tool's pinned schema, as the capture ticket's (KOBE-441):
    // Pi records the model's raw arguments but converts them before calling the tool.
    const pendingTool = await tx.execute<{ connector_id: string; tool: string }>(sql`
      SELECT connector_id, tool FROM thread_app_results
       WHERE team_id = ${teamId} AND run_id = ${runId} AND pi_name = ${event.payload.tool}
         AND tool_call_id IS NULL AND entry_id IS NULL
       LIMIT 1`);
    const target = pendingTool.rows[0];
    if (!target) continue;
    const schema = await pinnedInputSchema(tx, target.connector_id, target.tool);
    const digest = appInputDigest(schema, input.data);
    const candidates = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM thread_app_results
       WHERE team_id = ${teamId} AND run_id = ${runId} AND pi_name = ${event.payload.tool}
         AND input_sha256 = ${digest} AND tool_call_id IS NULL AND entry_id IS NULL`);
    if ((candidates.rows[0]?.n ?? 0) !== 1) continue;
    const claimed = await tx.execute<{
      id: string;
      connector_id: string;
      app_id: string;
      template_sha256: string;
    }>(sql`
      UPDATE thread_app_results SET tool_call_id = ${event.payload.tool_call_id}, claimed_at = now(),
             prompt_entry_id = (SELECT r.user_entry_id FROM runs r
                                 WHERE r.team_id = ${teamId} AND r.id = ${runId})
       WHERE team_id = ${teamId} AND id = (
         SELECT id FROM thread_app_results
          WHERE team_id = ${teamId} AND run_id = ${runId} AND pi_name = ${event.payload.tool}
            AND input_sha256 = ${digest}
            AND tool_call_id IS NULL AND entry_id IS NULL
          ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
         AND NOT EXISTS (
           SELECT 1 FROM thread_app_results d
            WHERE d.team_id = ${teamId} AND d.run_id = ${runId}
              AND d.tool_call_id = ${event.payload.tool_call_id})
       RETURNING id, connector_id, app_id, template_sha256`);
    const row = claimed.rows[0];
    if (row) {
      marked.set(event, {
        connector_id: row.connector_id,
        app_id: row.app_id,
        template_sha256: row.template_sha256,
        result_ref: row.id,
      });
    }
  }
  return events.map((e) => {
    const app = marked.get(e);
    return app ? { type: e.type, payload: { ...(e.payload as object), app } } : e;
  });
}
