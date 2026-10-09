import type { AuditEntry, TeamAuditEntry } from "@kobe/db";

/** Which view an export reads: the install log (all fields) or a team's view (no IP or chain). */
export type ExportScope = "install" | "team";
export type ExportFormat = "csv" | "jsonl";

type Entry = AuditEntry | TeamAuditEntry;

const TEAM_COLUMNS = [
  "seq",
  "id",
  "at",
  "team_id",
  "actor_kind",
  "actor_id",
  "actor_name",
  "actor_email",
  "action",
  "target",
] as const;
const INSTALL_COLUMNS = [...TEAM_COLUMNS, "ip", "user_agent", "prev_hash", "hash"] as const;

export function exportColumns(scope: ExportScope): readonly string[] {
  return scope === "install" ? INSTALL_COLUMNS : TEAM_COLUMNS;
}

/**
 * Cells starting with one of these are read as formulas by spreadsheets. Names, emails and user
 * agents are user-controlled, so such cells get a leading apostrophe (OWASP CSV injection).
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvHeader(scope: ExportScope): string {
  return `${exportColumns(scope).join(",")}\r\n`;
}

export function csvRow(entry: Entry, scope: ExportScope): string {
  const install = "hash" in entry ? entry : null;
  const cells = [
    entry.seq,
    entry.id,
    entry.at.toISOString(),
    entry.teamId,
    entry.actor.kind,
    entry.actor.id,
    entry.actor.name,
    entry.actor.email,
    entry.action,
    JSON.stringify(entry.target),
    ...(scope === "install"
      ? [install?.ip, install?.userAgent, install?.prevHash, install?.hash]
      : []),
  ];
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/** One JSON object per line, shaped like the read API's events. */
export function jsonlRow(entry: Entry, scope: ExportScope): string {
  const install = "hash" in entry ? entry : null;
  return `${JSON.stringify({
    seq: entry.seq,
    id: entry.id,
    at: entry.at.toISOString(),
    teamId: entry.teamId,
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    ...(scope === "install" && install
      ? {
          ip: install.ip,
          userAgent: install.userAgent,
          prevHash: install.prevHash,
          hash: install.hash,
        }
      : {}),
  })}\n`;
}

export function formatPage(
  events: readonly Entry[],
  format: ExportFormat,
  scope: ExportScope,
): string {
  const row = format === "csv" ? csvRow : jsonlRow;
  return events.map((e) => row(e, scope)).join("");
}

export const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  jsonl: "application/x-ndjson; charset=utf-8",
};
