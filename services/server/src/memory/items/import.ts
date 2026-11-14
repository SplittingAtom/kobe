import { sql, type KobeDb } from "@kobe/db";
import {
  SEMANTIC_MEMORY_IMPORT_ROW_STATUSES,
  SEMANTIC_MEMORY_PINS_MAX,
  SEMANTIC_MEMORY_POLICY_MAX_BYTES,
  SEMANTIC_MEMORY_POLICY_MAX_ITEMS,
  type SemanticMemoryImportCommitRequest,
  type SemanticMemoryImportCommitResponse,
  type SemanticMemoryImportPreviewRequest,
  type SemanticMemoryImportPreviewResponse,
  type SemanticMemoryImportRow,
  type SemanticMemoryIssue,
  type SemanticMemoryOverrides,
  type SemanticMemoryScope,
} from "@kobe/protocol";
import type { ServerAuditEvent } from "../../audit/record.js";
import { readPolicyAndLexemesMany } from "../checks/policy.js";
import { findSecret } from "../checks/secrets.js";
import {
  enforceMemoryFindings,
  evaluateMemoryWrite,
  importRowStatus,
  overrideAuditEvents,
  type CheckMemo,
  type MemoryCheckOutcome,
  type MemoryFindings,
} from "../checks.js";
import { parseImport, type ImportRow } from "../transfer/parse.js";
import { NEAR_DUPLICATE_WARNING, findNearDuplicatesMany } from "./duplicates.js";
import { audit, auditTeam, inStore, textArray, type Op } from "./context.js";
import { MemoryItemError, disabled, invalid } from "./errors.js";
import { assertRoom, lockScope, notifyNearFull, policyUsage } from "./limits.js";
import { workspaceTeam } from "./location.js";
import { insertVersion } from "./versions.js";
import { assertMayWrite, type MemoryWho } from "./who.js";

/**
 * Import (KOBE-385; contract KOBE-377 `transfer.ts`, SM21, Q10). Preview reads the file, applies
 * the scope rules and runs THE deterministic save checks on every row (`evaluateMemoryWrite`,
 * KOBE-379: secret scan, lint, personal data, links, near-duplicate, Policy conflict) and stores
 * nothing. No learning model is asked (Q10). Commit runs the same classification again under the
 * scope lock and saves the accepted rows all or nothing (`enforceMemoryFindings`, the checks'
 * enforcement), each as version 1 with `actor_kind = 'import'`.
 *
 * Row issue codes beside the KOBE-379 warning codes: `invalid_row` (doesn't parse), `secret`,
 * `policy_conflict`, and the Policy rules `policy_off_site`, `policy_pinned`,
 * `policy_not_allowed`, `policy_budget` (the Site's 25 items / 2 KiB, counted down the file),
 * plus `portable_kind`, `portable_as_of`, `ref_repeated`, `superseded_by`.
 */

type RowStatus = (typeof SEMANTIC_MEMORY_IMPORT_ROW_STATUSES)[number];

interface Classified {
  readonly row: ImportRow;
  readonly status: RowStatus;
  readonly issues: SemanticMemoryIssue[];
  /** Null when a scope rule or parse error stopped the checks. */
  readonly findings: MemoryFindings | null;
  /** The row only fails the Policy budget (commit answers `memory_policy_budget_full`). */
  readonly overBudget: boolean;
  /** What the secret found looks like (a blocked row). */
  readonly secretLabel: string | null;
}

const STATEMENT_SHOWN_MAX = 1000;
const ISSUES_MAX = 20;

const rule = (code: string, message: string): SemanticMemoryIssue => ({ code, message });

/** The scope rules the DB and the contract enforce, per row (no database). */
function scopeRuleIssue(
  row: ImportRow,
  scope: SemanticMemoryScope,
  who: MemoryWho,
  refs: ReadonlyMap<string, number>,
): SemanticMemoryIssue | null {
  if (row.error !== null) return rule("invalid_row", row.error);
  if (row.policy) {
    if (scope !== "site") return rule("policy_off_site", "Policy exists only on the Site.");
    if (row.pinned)
      return rule("policy_pinned", "Policy is always given to agents, so it is never pinned.");
    try {
      assertMayWrite(who, "site", { policyField: true, targetIsPolicy: false });
    } catch {
      return rule("policy_not_allowed", "Only Site admins import Policy.");
    }
  }
  if (scope === "portable" && row.kind !== "preference")
    return rule("portable_kind", "Only preferences follow you into all your workspaces.");
  if (scope === "portable" && row.asOf !== null)
    return rule("portable_as_of", "Preferences in all your workspaces have no as-of date.");
  if (row.ref !== null && refs.get(row.ref) !== row.index)
    return rule("ref_repeated", "Another row has the same ref.");
  if (row.status === "superseded") {
    const target = row.supersededBy === null ? undefined : refs.get(row.supersededBy);
    if (target === undefined || target === row.index)
      return rule("superseded_by", "superseded_by names no other row of this file.");
  } else if (row.supersededBy !== null)
    return rule("superseded_by", "Only a superseded row names superseded_by.");
  return null;
}

const normalised = (s: string) => s.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();

/** A credential anywhere in the row, scanned before anything else (review-385 L-1). */
const secretIn = (row: ImportRow) =>
  [row.statement, ...row.tags].map(findSecret).find((hit) => hit !== undefined) ?? null;

/** The switches, per row (review-385 L-2): Policy follows the Policy switch, the rest the scope's. */
function switchIssue(row: ImportRow, op: Op): SemanticMemoryIssue | null {
  if (row.policy && !op.memory.policy)
    return rule("policy_disabled", "Policy is turned off for the site.");
  if (!row.policy && !op.memory.scopes[op.loc.scope])
    return rule("scope_disabled", "Memories here are turned off; only Policy can be imported.");
  return null;
}

/** One query each for the rows' near-duplicates and Policy lexemes (review-385 M-2). */
async function prefetch(op: Op, rows: readonly ImportRow[]): Promise<CheckMemo> {
  const statements = rows.filter((r) => r.error === null).map((r) => r.statement);
  const duplicates = await findNearDuplicatesMany(op.tx, op.loc, statements);
  const { policies, lexemes } = op.memory.policy
    ? await readPolicyAndLexemesMany(
        op.tx,
        rows.filter((r) => r.error === null && !r.policy).map((r) => r.statement),
      )
    : { policies: [], lexemes: new Map<string, string[]>() };
  return { duplicates, policies, lexemes, egress: new Map() };
}

const invalidRow = (
  row: ImportRow,
  issue: SemanticMemoryIssue,
  overBudget = false,
): Classified => ({
  row,
  status: "invalid",
  issues: [issue],
  findings: null,
  overBudget,
  secretLabel: null,
});

/**
 * Every row's status and issues, in file order. `only`: the rows that count (commit's accepted
 * rows); the Policy budget and in-file repeats are counted over those alone.
 */
async function classify(
  op: Op,
  rows: readonly ImportRow[],
  only?: ReadonlySet<number>,
): Promise<Classified[]> {
  const scope = op.loc.scope;
  const refs = new Map<string, number>();
  for (const r of rows) if (r.ref !== null && !refs.has(r.ref)) refs.set(r.ref, r.index);
  const policy = rows.some((r) => r.policy) ? await policyUsage(op.tx) : { count: 0, bytes: 0 };
  let policyCount = policy.count;
  let policyBytes = policy.bytes;
  const memo = await prefetch(op, rows);
  const env = { ...op, memo };
  const seen = new Map<string, number>();
  const out: Classified[] = [];
  for (const row of rows) {
    const counted = only === undefined || only.has(row.index);
    const secret = secretIn(row);
    if (secret) {
      out.push({
        row,
        status: "blocked",
        issues: [
          rule("secret", `This looks like ${secret.label}. Secrets can never be saved in memory.`),
        ],
        findings: null,
        overBudget: false,
        secretLabel: secret.label,
      });
      continue;
    }
    const ruleIssue = scopeRuleIssue(row, scope, op.who, refs) ?? switchIssue(row, op);
    if (ruleIssue) {
      out.push(invalidRow(row, ruleIssue));
      continue;
    }
    if (row.policy && row.status === "active" && counted) {
      const bytes = Buffer.byteLength(row.statement, "utf8");
      if (
        policyCount + 1 > SEMANTIC_MEMORY_POLICY_MAX_ITEMS ||
        policyBytes + bytes > SEMANTIC_MEMORY_POLICY_MAX_BYTES
      ) {
        const issue = rule(
          "policy_budget",
          `Policy holds at most ${SEMANTIC_MEMORY_POLICY_MAX_ITEMS} items and ${SEMANTIC_MEMORY_POLICY_MAX_BYTES} bytes; this row would pass it.`,
        );
        out.push(invalidRow(row, issue, true));
        continue;
      }
      policyCount += 1;
      policyBytes += bytes;
    }
    let findings = await evaluateMemoryWrite(env, {
      scope,
      policy: row.policy,
      statement: row.statement,
      tags: row.tags,
    });
    const key = normalised(row.statement);
    const first = seen.get(key);
    let repeat: SemanticMemoryIssue | null = null;
    if (counted && first === undefined) seen.set(key, row.index);
    else if (counted && first !== undefined && importRowStatus(findings) === "new") {
      // An in-file repeat is a near-duplicate like one of a saved item: saved only over
      // `overrides.lint`, recorded and audited (review-385 L-3).
      findings = { ...findings, warnings: [...findings.warnings, NEAR_DUPLICATE_WARNING] };
      repeat = rule("near_duplicate", `Repeats row ${first + 1} of this file.`);
    }
    const issues: SemanticMemoryIssue[] = [];
    if (findings.invalid !== null) issues.push(rule("invalid_row", findings.invalid));
    issues.push(...(repeat ? findings.warnings.slice(0, -1) : findings.warnings));
    if (repeat) issues.push(repeat);
    if (findings.policyConflicts.length > 0)
      issues.push(
        rule(
          "policy_conflict",
          "This may contradict Site Policy. Saving it anyway is recorded in the audit log.",
        ),
      );
    out.push({
      row,
      status: repeat ? "duplicate" : importRowStatus(findings),
      issues: issues.slice(0, ISSUES_MAX),
      findings,
      overBudget: false,
      secretLabel: null,
    });
  }
  return out;
}

function wireRow(c: Classified): SemanticMemoryImportRow {
  const { row, status } = c;
  const blocked = status === "blocked";
  const shown = blocked ? `[withheld: looks like ${c.secretLabel ?? "a secret"}]` : row.statement;
  return {
    index: row.index,
    status,
    kind: row.kind,
    statement: [...shown].slice(0, STATEMENT_SHOWN_MAX).join(""),
    tags: blocked ? [] : row.tags.slice(0, 20).map((t) => [...t].slice(0, 100).join("")),
    pinned: row.pinned,
    policy: row.policy,
    as_of: row.asOf,
    issues: c.issues,
  };
}

/**
 * The scope must be on; on the Site, Policy alone may be imported while Site memories are off
 * (rows are then checked one by one: {@link switchIssue}).
 */
function assertImportEnabled(op: Op): void {
  const scope = op.loc.scope;
  if (op.memory.scopes[scope] || (scope === "site" && op.memory.policy)) return;
  throw disabled();
}

/** Preview: every row classified; nothing is stored. */
export function previewImport(
  db: KobeDb,
  who: MemoryWho,
  req: SemanticMemoryImportPreviewRequest,
): Promise<SemanticMemoryImportPreviewResponse> {
  const rows = parseImport(req.format, req.content);
  return inStore(db, who, req.scope, async (op) => {
    assertImportEnabled(op);
    assertMayWrite(who, req.scope);
    const classified = await classify(op, rows);
    const counts = Object.fromEntries(SEMANTIC_MEMORY_IMPORT_ROW_STATUSES.map((s) => [s, 0])) as {
      [K in RowStatus]: number;
    };
    for (const c of classified) counts[c.status] += 1;
    return { scope: req.scope, rows: classified.map(wireRow), counts };
  });
}

/** What saving an accepted row goes through, or null when it may not be saved (stale). */
function outcomeOf(
  c: Classified,
  overrides: SemanticMemoryOverrides | undefined,
  who: MemoryWho,
  scope: SemanticMemoryScope,
): MemoryCheckOutcome | null {
  if (c.findings === null || c.status === "invalid" || c.status === "blocked") return null;
  // A near-duplicate (of a saved item or of an earlier row) is saved only over `overrides.lint`,
  // like Save anyway; a clean-rows commit sends none, so a row that became one is stale.
  if ((c.status === "duplicate" || c.status === "warning") && overrides === undefined) return null;
  if (c.status === "duplicate" && overrides?.lint !== true) return null;
  try {
    return enforceMemoryFindings(c.findings, overrides, who, scope);
  } catch (err) {
    if (err instanceof MemoryItemError) return null;
    throw err;
  }
}

/** Commit: the accepted rows, checked again, saved all or nothing. */
export function commitImport(
  db: KobeDb,
  who: MemoryWho,
  req: SemanticMemoryImportCommitRequest,
): Promise<SemanticMemoryImportCommitResponse> {
  const rows = parseImport(req.format, req.content);
  const accept = new Set(req.accept);
  if (req.accept.some((i) => i >= rows.length))
    throw invalid("accept names a row the file doesn't have.");
  return inStore(db, who, req.scope, async (op) => {
    const scope = req.scope;
    assertImportEnabled(op);
    assertMayWrite(who, scope);
    await lockScope(op.tx, op.loc);
    if (rows.some((r) => accept.has(r.index) && r.policy))
      await op.tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('kobe.memory-policy', 0))`,
      );
    const classified = (await classify(op, rows, accept)).filter((c) => accept.has(c.row.index));
    if (classified.some((c) => c.overBudget))
      throw new MemoryItemError(
        "memory_policy_budget_full",
        `Policy holds at most ${SEMANTIC_MEMORY_POLICY_MAX_ITEMS} items and ${SEMANTIC_MEMORY_POLICY_MAX_BYTES} bytes of text.`,
      );
    const outcomes = classified.map((c) => outcomeOf(c, req.overrides, who, scope));
    const stale = classified.filter((_, i) => outcomes[i] === null).map((c) => c.row.index);
    if (stale.length > 0)
      throw new MemoryItemError(
        "memory_import_stale",
        "Some accepted rows changed since the preview. Preview the file again; nothing was saved.",
        { import_rows: stale },
      );
    const refIndex = new Map(classified.map((c) => [c.row.ref, c.row.index]));
    for (const c of classified)
      if (c.row.status === "superseded" && !accept.has(refIndex.get(c.row.supersededBy) ?? -1))
        throw invalid(
          `Row ${c.row.index + 1} is superseded: accept the row its superseded_by names too.`,
        );

    const active = classified.filter((c) => c.row.status === "active");
    // Every imported row needs room, archived and superseded ones too (review-385 M-2): an
    // import can't grow a scope's history past its cap.
    const before = await assertRoom(op.tx, op.loc, op.settings, classified.length);
    await assertPinsFit(op, active.filter((c) => c.row.pinned).length);

    const ids = new Map<number, string>();
    const events: ServerAuditEvent[] = [];
    const teamId = auditTeam(op.loc);
    for (const [i, c] of classified.entries()) {
      const outcome = outcomes[i] as MemoryCheckOutcome;
      const id = await insertImported(op, c.row);
      ids.set(c.row.index, id);
      await insertVersion(op.tx, op.loc, {
        itemId: id,
        version: 1,
        statement: c.row.statement,
        actorKind: "import",
        lintOverride: outcome.lintOverride,
        policyOverride: outcome.policyOverride,
      });
      events.push({
        action: "memory.item.created",
        teamId,
        target: {
          scope,
          itemId: id,
          kind: c.row.kind ?? "fact",
          version: 1,
          actorKind: "import",
          pinned: c.row.pinned,
          policy: c.row.policy,
        },
      });
      events.push(...overrideAuditEvents(outcome, { scope, itemId: id, version: 1, teamId }));
    }
    for (const c of classified) {
      if (c.row.status !== "superseded") continue;
      const id = ids.get(c.row.index) as string;
      const by = ids.get(refIndex.get(c.row.supersededBy) as number) as string;
      await op.tx.execute(sql`
        UPDATE ${op.loc.items} i SET status = 'superseded', superseded_by = ${by}, updated_at = now()
         WHERE ${op.loc.where} AND i.id = ${id}`);
      events.push({
        action: "memory.item.superseded",
        teamId,
        target: { scope, itemId: id, supersededBy: by },
      });
    }
    events.push({
      action: "memory.items.imported",
      teamId,
      target: {
        scope,
        format: req.format,
        created: classified.length,
        skipped: rows.length - classified.length,
      },
    });
    op.pending = await notifyNearFull(op.tx, op.loc, op.settings, before, before + active.length);
    await audit(op, events);
    const itemIds = classified.map((c) => ids.get(c.row.index) as string);
    return { scope, created: itemIds.length, item_ids: itemIds };
  });
}

/** Refuses an import whose pinned rows would pass the scope's 10 pinned active items. */
async function assertPinsFit(op: Op, adding: number): Promise<void> {
  if (adding === 0) return;
  const { rows } = await op.tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM ${op.loc.items} i
     WHERE ${op.loc.where} AND i.status = 'active' AND i.pinned`);
  if ((rows[0]?.n ?? 0) + adding > SEMANTIC_MEMORY_PINS_MAX)
    throw new MemoryItemError(
      "memory_pin_limit",
      `This scope holds at most ${SEMANTIC_MEMORY_PINS_MAX} pinned memories; the import would pass it. Unpin some first, or import the rows unpinned.`,
    );
}

/** The item row of an imported row (superseded rows start archived and are linked after). */
async function insertImported(op: Op, row: ImportRow): Promise<string> {
  const { loc } = op;
  const tags = textArray(row.tags);
  const status = row.status === "active" ? "active" : "archived";
  const kind = row.kind ?? "fact";
  const insert =
    loc.scope === "user" || loc.scope === "team"
      ? sql`INSERT INTO semantic_memory_items (team_id, scope, owner_user_id, kind, status, pinned, tags, as_of)
            VALUES (${workspaceTeam(loc)}, ${loc.scope}, ${loc.scope === "user" ? loc.userId : null}, ${kind}, ${status}, ${row.pinned}, ${tags}, ${row.asOf}::date)
            RETURNING id`
      : loc.scope === "portable"
        ? sql`INSERT INTO portable_memory_items (owner_user_id, kind, status, pinned, tags)
              VALUES (${loc.userId}, ${kind}, ${status}, ${row.pinned}, ${tags}) RETURNING id`
        : sql`INSERT INTO site_memory_items (kind, status, pinned, tags, policy, as_of)
              VALUES (${kind}, ${status}, ${row.pinned}, ${tags}, ${row.policy}, ${row.asOf}::date) RETURNING id`;
  const { rows } = await op.tx.execute<{ id: string }>(insert);
  const id = rows[0]?.id;
  if (!id) throw new Error("memory item insert returned no id");
  return id;
}
