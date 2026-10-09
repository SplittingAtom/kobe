import {
  SYSTEM_ACTOR,
  and,
  connectors,
  eq,
  isNull,
  parseToolsSnapshot,
  sql,
  type KobeDb,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import { logger } from "../logger.js";
import type { MailMessage, Mailer } from "../mail/mailer.js";
import { oneLine } from "../mail/messages.js";
import { driftRecipients, type DriftRecipient } from "./drift-recipients.js";

/**
 * Emails about connector tool drift (KOBE-103, D27). Driven by the audit log, so no table is
 * needed: every `mcp.connector.drift` event of the last {@link MAX_AGE_HOURS} h whose tools are
 * still awaiting re-approval is delivered to each recipient once. Delivery writes an
 * `mcp.connector.drift_notified` row per (event, recipient) after the SMTP server accepted the
 * message (at least once: a failed send is retried by the next pass). Per connector and recipient
 * at most one email per {@link DEFAULT_WINDOW_MS}; a further event inside it is recorded with
 * `emailed: false` and not retried. The in-app notice (`/v1/me/connector-notices`) covers it.
 * Emails carry the connector and tool names only, never descriptions, schemas or URLs.
 */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_HOURS = 24;
const MAX_NAMES = 20;

export interface DriftNotifyDeps {
  readonly db: KobeDb;
  readonly mailer: Mailer;
  readonly publicUrl: string;
}

interface DriftEvent {
  readonly seq: number;
  readonly connectorId: string;
  readonly name: string;
  readonly tools: readonly string[];
}

export function driftMessage(
  publicUrl: string,
  event: Pick<DriftEvent, "name" | "tools">,
  to: string,
): MailMessage {
  const name = oneLine(event.name);
  const shown = event.tools.slice(0, MAX_NAMES).map((t) => `  - ${oneLine(t)}`);
  const more = event.tools.length - shown.length;
  return {
    to,
    subject: `Connector ${name}: tools changed and are disabled`,
    text: [
      `The tools of the ${name} connector changed upstream. These tools are disabled in Kobe until`,
      "an install admin reviews and re-approves them:",
      ...shown,
      ...(more > 0 ? [`  ... and ${more} more`] : []),
      "",
      `Install admins can review them at ${publicUrl}/admin/connectors`,
    ].join("\n"),
  };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

async function recentEvents(db: KobeDb): Promise<DriftEvent[]> {
  const rows = await db.execute<{ seq: string; target: Record<string, unknown> }>(sql`
    SELECT seq, target FROM audit_log
     WHERE action = 'mcp.connector.drift' AND at > now() - make_interval(hours => ${MAX_AGE_HOURS})
     ORDER BY seq`);
  const events: DriftEvent[] = [];
  for (const { seq, target } of rows.rows) {
    if (typeof target.connectorId !== "string" || typeof target.name !== "string") continue;
    events.push({
      seq: Number(seq),
      connectorId: target.connectorId,
      name: target.name,
      tools: [...strings(target.changed), ...strings(target.added)],
    });
  }
  return events;
}

/** Still has tools awaiting re-approval (an approval or a removal ends the notice). */
async function stillDrifted(db: KobeDb, connectorId: string): Promise<boolean> {
  const [row] = await db
    .select({ snapshot: connectors.toolsSnapshot })
    .from(connectors)
    .where(and(eq(connectors.id, connectorId), isNull(connectors.deletedAt)));
  return !!row && parseToolsSnapshot(row.snapshot).some((t) => t.status === "drifted");
}

async function handled(db: KobeDb, seq: number): Promise<Set<string>> {
  const rows = await db.execute<{ recipient: string }>(sql`
    SELECT target->>'recipientId' AS recipient FROM audit_log
     WHERE action = 'mcp.connector.drift_notified' AND (target->>'driftSeq')::bigint = ${seq}`);
  return new Set(rows.rows.map((r) => r.recipient));
}

async function rateLimited(
  db: KobeDb,
  connectorId: string,
  recipientId: string,
  windowMs: number,
): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM audit_log
     WHERE action = 'mcp.connector.drift_notified'
       AND target->>'connectorId' = ${connectorId} AND target->>'recipientId' = ${recipientId}
       AND (target->>'emailed')::boolean AND at > now() - make_interval(secs => ${windowMs / 1000})
     LIMIT 1`);
  return rows.rows.length > 0;
}

const record = (db: KobeDb, event: DriftEvent, recipient: DriftRecipient, emailed: boolean) =>
  db.transaction((tx) =>
    recordAudit(tx, {
      action: "mcp.connector.drift_notified",
      actor: SYSTEM_ACTOR,
      target: {
        connectorId: event.connectorId,
        driftSeq: event.seq,
        recipientId: recipient.userId,
        emailed,
      },
    }),
  );

/** One pass. Never throws; returns the emails sent. */
export async function notifyDrift(
  deps: DriftNotifyDeps,
  options: { readonly windowMs?: number } = {},
): Promise<number> {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  let sent = 0;
  try {
    for (const event of await recentEvents(deps.db)) {
      if (!(await stillDrifted(deps.db, event.connectorId))) continue;
      const done = await handled(deps.db, event.seq);
      for (const recipient of await driftRecipients(deps.db, event.connectorId)) {
        if (done.has(recipient.userId)) continue;
        try {
          if (await rateLimited(deps.db, event.connectorId, recipient.userId, windowMs)) {
            await record(deps.db, event, recipient, false);
            continue;
          }
          await deps.mailer.send(driftMessage(deps.publicUrl, event, recipient.email));
          sent += 1;
          await record(deps.db, event, recipient, true);
        } catch (err) {
          logger.warn(
            { err, connectorId: event.connectorId, recipientId: recipient.userId },
            "connector drift email failed; will retry",
          );
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "connector drift notification pass failed");
  }
  return sent;
}
