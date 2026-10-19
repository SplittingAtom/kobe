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
import { driftRecipients, siteAdminIds, type DriftRecipient } from "./drift-recipients.js";
import { CONSOLE_PATHS } from "../mail/console-paths.js";

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
  /** `skipped`: the refresh began skipping it for want of credentials (KOBE-431). */
  readonly kind: "drift" | "skipped";
  readonly connectorId: string;
  readonly name: string;
  readonly tools: readonly string[];
  /** Skip events: whose key the connector uses, for the remedy text (review L2). */
  readonly source?: "member" | "site";
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
      "a site admin reviews and re-approves them:",
      ...shown,
      ...(more > 0 ? [`  ... and ${more} more`] : []),
      "",
      `Site admins can review them at ${publicUrl}${CONSOLE_PATHS.siteConnectors}`,
    ].join("\n"),
  };
}

/** KOBE-431: the refresh cannot check a connector for changes; site admins only. */
export function skippedMessage(
  publicUrl: string,
  event: Pick<DriftEvent, "name" | "source">,
  to: string,
): MailMessage {
  const name = oneLine(event.name);
  const fix =
    event.source === "site"
      ? [
          `The ${name} connector uses a site-wide key, and it has none Kobe can use (not set, or`,
          "its server URL changed since it was set). Set (or re-enter) its site-wide key.",
        ]
      : [
          "Add your own key for the connector (My connector keys, in a team that enabled it) and",
          "pin or approve its tools, or give it a site-wide key.",
        ];
  return {
    to,
    subject: `Connector ${name}: tools are not checked for changes`,
    text: [
      `The ${name} connector asks for credentials, and Kobe has none to check its tools with:`,
      "it has no site-wide key, and the site admin who last pinned or approved its tools has no",
      "usable key for it (deactivated, no longer an admin, or the key was removed or expired).",
      "Until that changes, new or changed tools on the server are not noticed.",
      "",
      ...fix,
      "",
      `Site admins can review it at ${publicUrl}${CONSOLE_PATHS.siteConnectors}`,
    ].join("\n"),
  };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

async function recentEvents(db: KobeDb): Promise<DriftEvent[]> {
  const rows = await db.execute<{
    seq: string;
    action: string;
    target: Record<string, unknown>;
  }>(sql`
    SELECT seq, action, target FROM audit_log
     WHERE action IN ('mcp.connector.drift', 'mcp.connector.refresh_skipped')
       AND at > now() - make_interval(hours => ${MAX_AGE_HOURS})
     ORDER BY seq`);
  const events: DriftEvent[] = [];
  for (const { seq, action, target } of rows.rows) {
    if (typeof target.connectorId !== "string" || typeof target.name !== "string") continue;
    events.push({
      seq: Number(seq),
      kind: action === "mcp.connector.refresh_skipped" ? "skipped" : "drift",
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

/**
 * Still skipped for want of credentials (a good pass or a new URL ends the notice): the event with
 * the connector's credential source, or undefined when it is over.
 */
async function stillSkipped(db: KobeDb, event: DriftEvent): Promise<DriftEvent | undefined> {
  const [row] = await db
    .select({ skipped: connectors.refreshSkipped, source: connectors.credentialSource })
    .from(connectors)
    .where(and(eq(connectors.id, event.connectorId), isNull(connectors.deletedAt)));
  return row?.skipped === "auth_required" ? { ...event, source: row.source } : undefined;
}

const stillCurrent = async (db: KobeDb, event: DriftEvent): Promise<DriftEvent | undefined> =>
  event.kind === "skipped"
    ? stillSkipped(db, event)
    : (await stillDrifted(db, event.connectorId))
      ? event
      : undefined;

/** Who hears about an event: a skip only concerns site admins, who can fix it. */
const recipientsOf = async (db: KobeDb, event: DriftEvent) => {
  const all = await driftRecipients(db, event.connectorId);
  if (event.kind === "drift") return all;
  const admins = new Set((await siteAdminIds(db)).map((r) => r.userId));
  return all.filter((r) => admins.has(r.userId));
};

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
  /** Per kind (review L3): a skip email never holds back a drift email, nor the reverse. */
  kind: DriftEvent["kind"],
): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM audit_log
     WHERE action = 'mcp.connector.drift_notified'
       AND target->>'connectorId' = ${connectorId} AND target->>'recipientId' = ${recipientId}
       AND COALESCE(target->>'kind', 'drift') = ${kind}
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
        kind: event.kind,
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
    for (const recent of await recentEvents(deps.db)) {
      const event = await stillCurrent(deps.db, recent);
      if (!event) continue;
      const done = await handled(deps.db, event.seq);
      for (const recipient of await recipientsOf(deps.db, event)) {
        if (done.has(recipient.userId)) continue;
        try {
          if (
            await rateLimited(deps.db, event.connectorId, recipient.userId, windowMs, event.kind)
          ) {
            await record(deps.db, event, recipient, false);
            continue;
          }
          const message = event.kind === "skipped" ? skippedMessage : driftMessage;
          await deps.mailer.send(message(deps.publicUrl, event, recipient.email));
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
