import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { dutiesProblem } from "./review-duties.js";
import { DECIDABLE_STATES, PROBLEMS, type Problem } from "./review-problems.js";
import { versionRow } from "./review-queue.js";
import { externalCautionFindings } from "./external-scan-result.js";

/**
 * Caution findings are acknowledged one by one before Approve (KOBE-334 review M1, coordinator
 * decision; SK32 "each finding needs a reviewer's acknowledgement"). A finding is named by its
 * rule, file and line (`rule@file:line`); each acknowledgement is a review event
 * (`finding_acknowledged`, the key in its `checklist`) and an audit row, and Approve is refused
 * while any Caution finding of the version's scan has none. Block findings are not acknowledged:
 * a Block verdict is a Site admin's override with a reason.
 */

interface StoredFinding {
  readonly rule?: unknown;
  readonly file?: unknown;
  readonly line?: unknown;
  readonly severity?: unknown;
}

export const findingKey = (f: StoredFinding): string =>
  `${String(f.rule ?? "")}@${String(f.file ?? "")}:${Number(f.line ?? 0)}`;

/**
 * The scan's Caution findings' keys (a finding stored without a severity counts as Caution), and
 * the external scanner's Caution findings (KOBE-341: advisory, acknowledged like Kobe's own).
 */
export function cautionKeys(scan: Record<string, unknown>): string[] {
  const findings = Array.isArray(scan.findings) ? (scan.findings as StoredFinding[]) : [];
  return [
    ...new Set([
      ...findings.filter((f) => f.severity !== "block").map(findingKey),
      ...externalCautionFindings(scan).map(findingKey),
    ]),
  ];
}

export interface Acknowledgement {
  readonly by: { readonly id: string; readonly name: string };
  readonly at: string;
}

/** Who acknowledged each finding of the version, by key (the first acknowledgement). */
export async function acknowledgements(
  db: KobeDb | KobeTx,
  versionId: string,
): Promise<Map<string, Acknowledgement>> {
  const res = await db.execute<{ key: string; actor_id: string; name: string; at: Date }>(sql`
    SELECT e.checklist ->> 'finding' AS key, e.actor_id, u.name, e.at
      FROM registry_review_events e JOIN users u ON u.id = e.actor_id
     WHERE e.version_id = ${versionId} AND e.action = 'finding_acknowledged'
     ORDER BY e.at, e.id`);
  const out = new Map<string, Acknowledgement>();
  for (const r of res.rows)
    if (!out.has(r.key))
      out.set(r.key, {
        by: { id: r.actor_id, name: r.name },
        at: new Date(r.at).toISOString(),
      });
  return out;
}

/** Approve's check: every Caution finding acknowledged. */
export async function unacknowledgedProblem(
  tx: KobeTx,
  versionId: string,
  scan: Record<string, unknown>,
): Promise<Problem | null> {
  const keys = cautionKeys(scan);
  if (keys.length === 0) return null;
  const done = await acknowledgements(tx, versionId);
  const left = keys.filter((k) => !done.has(k)).length;
  if (left === 0) return null;
  return {
    code: "findings_unacknowledged",
    message: `Acknowledge each Caution finding before approving (${left} left).`,
  };
}

export type AcknowledgeResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly problem: Problem };

const UNKNOWN: Problem = {
  code: "unknown_finding",
  message: "The version's scan has no such Caution finding.",
};

/** Records `userId`'s acknowledgement of one Caution finding (idempotent per finding). */
export async function acknowledge(
  db: KobeDb,
  versionId: string,
  userId: string,
  key: string,
): Promise<AcknowledgeResult> {
  return db.transaction(async (tx) => {
    const v = await versionRow(tx, versionId, true);
    if (!v || v.publisher !== "maintainer") return { ok: false, problem: PROBLEMS.not_found };
    if (!DECIDABLE_STATES.has(v.state)) return { ok: false, problem: PROBLEMS.decided };
    if (!cautionKeys(v.scan).includes(key)) return { ok: false, problem: UNKNOWN };
    // Separation of duties (review-335 M1): the submitter and the confirming Team admin don't
    // acknowledge their own findings, except on a single-admin Site (flagged on approval).
    const duties = await dutiesProblem(tx, v, userId);
    if (duties.problem) return { ok: false, problem: duties.problem };
    if ((await acknowledgements(tx, v.id)).has(key)) return { ok: true, changed: false };
    await tx.execute(sql`
      INSERT INTO registry_review_events (version_id, actor_id, action, checklist)
      VALUES (${v.id}, ${userId}, 'finding_acknowledged',
        ${JSON.stringify({ finding: key })}::jsonb)`);
    await recordAudit(tx, {
      action: "registry.finding_acknowledged",
      target: { registryVersionId: v.id, finding: key.slice(0, 700) },
    });
    return { ok: true, changed: true };
  });
}
