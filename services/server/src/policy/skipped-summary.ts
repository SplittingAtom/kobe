import {
  type KobeEventType,
  type PolicyReasonCode,
  type RiskClass,
  type SkippedAction,
} from "@kobe/protocol";
import { sql, threadEntries, type KobeTx } from "@kobe/db";
import type { NewRunEvent } from "../event-stream/append.js";
import { loadSkippedReport } from "./skipped-actions.js";

/**
 * The 'Skipped actions' report of a scheduled run (D32, KOBE-178), built by the server from a
 * template: no model writes it and Pi is not told anything at start. It reaches the reader twice,
 * written in the transaction that ends the run: the optional `skipped_actions` field of the
 * terminal event (KOBE-176) and one `custom_message` entry in the thread's entry tree.
 */

/** `customType` of the thread entry (also how the sync cursor recognises server-written entries). */
export const SKIPPED_ENTRY_TYPE = "kobe.skipped_actions";

/** Lines of the summary that name a call; the rest is counted. */
const SUMMARY_LINES_MAX = 20;

const RISK_LABEL: Readonly<Record<RiskClass, string>> = {
  read: "reads data",
  write: "changes data",
  destructive: "can change or delete data",
};

const REASON_LABEL: Readonly<Partial<Record<PolicyReasonCode, string>>> = {
  scheduled_run_no_prompt: "scheduled runs cannot ask for approval and it is not allow-listed",
  mode_auto_not_allowlisted: "auto mode only runs allow-listed tools",
  site_deny_rule: "blocked by policy",
  team_deny_rule: "blocked by policy",
  agent_tool_deny: "blocked by the agent's tool list",
  connector_exposure: "not exposed to agents in this team",
  connector_not_enabled: "its connector is not enabled",
  tool_drifted: "changed since it was approved",
};

/** The tool name comes from the sandbox's claim for unknown tools: plain characters only. */
function plainName(tool: string): string {
  return tool.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
}

/** The summary text; `count` is the true number of skipped calls (>= `actions.length`). */
export function skippedSummary(actions: readonly SkippedAction[], count: number): string {
  const total = Math.max(count, actions.length);
  const what = total === 1 ? "1 tool call was" : `${total} tool calls were`;
  const shown = actions.slice(0, SUMMARY_LINES_MAX);
  const lines = shown.map(
    (a) =>
      `- ${plainName(a.tool)} (${RISK_LABEL[a.risk]}): ${REASON_LABEL[a.reason_code] ?? "denied by policy"}`,
  );
  const more = total - shown.length;
  return [
    "Skipped actions",
    `This scheduled run does not wait for approval, so ${what} skipped:`,
    ...lines,
    ...(more > 0 ? [`- ...and ${more} more`] : []),
  ].join("\n");
}

const REPORTED_EVENTS: ReadonlySet<string> = new Set<KobeEventType>([
  "run.completed",
  "run.failed",
  "run.interrupted",
]);

/**
 * For a scheduled run ending with `event`: adds `skipped_actions` to the terminal event and appends
 * the summary entry to the thread, in `tx`. Returns `event` unchanged for any other run or event,
 * or when nothing was skipped. The entry hangs under the thread's leaf and never moves it (Pi
 * continues from its own leaf; the next run's `parent_entry_id` must stay an entry Pi knows).
 */
export async function reportSkippedActionsInTx(
  tx: KobeTx,
  run: { readonly teamId: string; readonly runId: string; readonly threadId: string },
  event: NewRunEvent,
  isScheduled: boolean,
): Promise<NewRunEvent> {
  if (!isScheduled || !REPORTED_EVENTS.has(event.type)) return event;
  const report = await loadSkippedReport(tx, run.teamId, run.runId);
  if (report.count === 0) return event;
  await appendSummaryEntry(tx, run, skippedSummary(report.actions, report.count), report.count);
  return {
    ...event,
    payload: { ...(event.payload as Record<string, unknown>), skipped_actions: report.actions },
  };
}

async function appendSummaryEntry(
  tx: KobeTx,
  run: { readonly teamId: string; readonly runId: string; readonly threadId: string },
  text: string,
  count: number,
): Promise<void> {
  const leaf = await tx.execute<{ leaf_entry_id: string | null }>(sql`
    SELECT leaf_entry_id FROM threads WHERE team_id = ${run.teamId} AND id = ${run.threadId}`);
  const parentId = leaf.rows[0]?.leaf_entry_id ?? null;
  // No entry was mirrored (the run ended before Pi wrote one): the event field is the report.
  if (parentId === null) return;
  // Pi's entry ids are short hex; a `ks-` id cannot collide, and one per run keeps it idempotent.
  const entryId = `ks-${run.runId.replaceAll("-", "").slice(0, 24)}`;
  await tx
    .insert(threadEntries)
    .values({
      teamId: run.teamId,
      threadId: run.threadId,
      entryId,
      parentId,
      type: "custom_message",
      payload: {
        type: "custom_message",
        id: entryId,
        parentId,
        timestamp: new Date().toISOString(),
        customType: SKIPPED_ENTRY_TYPE,
        content: text,
        display: true,
        details: { run_id: run.runId, skipped_count: count },
      },
    })
    .onConflictDoNothing();
}

/**
 * Whether `entryId` is a server-written skipped-actions entry. Pi does not know it, so it can be
 * neither a branch point (`run.start.parent_entry_id`) nor the thread's leaf.
 */
export async function isSkippedSummaryEntry(
  tx: KobeTx,
  teamId: string,
  threadId: string,
  entryId: string,
): Promise<boolean> {
  const res = await tx.execute(sql`
    SELECT 1 FROM thread_entries
     WHERE team_id = ${teamId} AND thread_id = ${threadId} AND entry_id = ${entryId}
       AND type = 'custom_message' AND payload ->> 'customType' = ${SKIPPED_ENTRY_TYPE}`);
  return res.rows.length > 0;
}
