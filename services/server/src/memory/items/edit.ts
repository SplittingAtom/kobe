import { sql, type KobeDb } from "@kobe/db";
import type {
  PatchSemanticMemoryItem,
  PinSemanticMemoryItem,
  RestoreSemanticMemoryItem,
  RevertSemanticMemoryItem,
  SemanticMemoryItemAction,
  SemanticMemoryItemDetail,
  SemanticMemoryScope,
} from "@kobe/protocol";
import type { ServerAuditEvent } from "../../audit/record.js";
import { siteMemoryHeld } from "../../legal-hold/site-memory-hold.js";
import {
  assertExpected,
  audit,
  auditTeam,
  inStore,
  loadForWrite,
  normaliseTags,
  sameTags,
  saveChecks,
  textArray,
  type Op,
} from "./context.js";
import {
  NO_OVERRIDES,
  assertNoSecretInTags,
  overrideAuditEvents,
  type MemoryCheckOutcome,
} from "../checks.js";
import { MemoryItemError, inactive, invalid } from "./errors.js";
import {
  assertPinRoom,
  assertPolicyBudget,
  assertRoom,
  lockScope,
  notifyNearFull,
} from "./limits.js";
import { detailOf, readItem, type ItemRow } from "./rows.js";
import { tagsFingerprint } from "./tag-fingerprint.js";
import { insertVersion, pruneVersions } from "./versions.js";
import { assertEnabled, assertMayWrite, type MemoryWho } from "./who.js";

type Scope = SemanticMemoryScope;

const notPinnable = () =>
  new MemoryItemError(
    "memory_policy_not_pinnable",
    "Policy is always in context, so a Policy memory can't be pinned.",
  );

/** Loads an item for a write after the switch and rights checks every write shares. */
async function prepare(
  op: Op,
  id: string,
  policyField: boolean,
  policyAfter: (row: ItemRow) => boolean = (row) => row.policy,
): Promise<ItemRow> {
  const row = await loadForWrite(op, id);
  // Both sides of the write must be on: a Policy item turned plain lands in Site memories, which
  // this Workspace may have switched off (review L-4), and the reverse reads a plain item.
  assertEnabled(op.memory, op.loc.scope, row.policy);
  assertEnabled(op.memory, op.loc.scope, policyAfter(row));
  assertMayWrite(op.who, op.loc.scope, { policyField, targetIsPolicy: row.policy });
  return row;
}

async function finish(op: Op, id: string, events: ServerAuditEvent[]) {
  const row = await readItem(op.tx, op.loc, id);
  if (!row) throw new Error("memory item vanished inside its own transaction");
  const detail = await detailOf(op.tx, op.loc, op.who, row, op.settings.stale_after_days);
  await audit(op, events);
  return detail;
}

/** Appends a version, moves `current_version` and prunes past the cap. */
async function appendStatement(
  op: Op,
  row: ItemRow,
  statement: string,
  checks: MemoryCheckOutcome,
): Promise<number> {
  const version = row.current_version + 1;
  await insertVersion(op.tx, op.loc, {
    itemId: row.id,
    version,
    statement,
    actorKind: "user",
    lintOverride: checks.lintOverride,
    policyOverride: checks.policyOverride,
  });
  await op.tx.execute(sql`
    UPDATE ${op.loc.items} i SET current_version = ${version}, updated_at = now()
     WHERE ${op.loc.where} AND i.id = ${row.id}`);
  await pruneVersions(
    op.portableHolds,
    op.tx,
    op.loc,
    { id: row.id, currentVersion: version, owner: row.owner_user_id },
    op.settings.version_cap,
  );
  return version;
}

/**
 * Edit (KOBE-378): a statement change is a new immutable version (with the save checks); kind,
 * tags, `as_of` and `policy` change the item. Rules of the stored item the body can't see are
 * `invalid_request`; a Policy change needs `site.memory.policy`. A Policy change runs the save
 * checks on the (unchanged) statement too (KOBE-379 review L-1: Policy is lint- and
 * conflict-exempt, so an item leaving Policy is checked as a plain Site item); overrides are
 * audited at the current version. A change of tags alone scans the tags for secrets.
 */
export function patchItem(
  db: KobeDb,
  who: MemoryWho,
  scope: Scope,
  id: string,
  body: PatchSemanticMemoryItem,
): Promise<SemanticMemoryItemDetail> {
  return inStore(db, who, scope, async (op) => {
    const row = await prepare(op, id, body.policy !== undefined, (r) => body.policy ?? r.policy);
    if (row.status !== "active") throw inactive();
    assertExpected(row, body.expected_version);
    if (scope === "portable" && body.kind !== undefined && body.kind !== "preference")
      throw invalid("Memories in all your workspaces are preferences.");
    if (scope === "portable" && body.as_of !== undefined)
      throw invalid("Memories in all your workspaces have no as-of date.");
    if (scope !== "site" && body.policy !== undefined)
      throw invalid("Policy exists only on the Site.");
    if (body.policy === true && row.pinned) throw notPinnable();

    const statement = body.statement ?? row.statement;
    const statementChanged = statement !== row.statement;
    const policy = body.policy ?? row.policy;
    if (policy && (statementChanged || !row.policy))
      await assertPolicyBudget(op.tx, [row.id], statement);
    const kind = body.kind ?? row.kind;
    const tags = body.tags ? normaliseTags(body.tags) : row.tags;
    const checked = statementChanged || policy !== row.policy;
    const checks = checked
      ? await saveChecks(op, { statement, policy, except: [row.id], tags }, body.overrides)
      : NO_OVERRIDES;
    if (!checked && body.tags) assertNoSecretInTags(tags);
    const asOf = body.as_of === undefined ? row.as_of : body.as_of;
    const changed = [
      ...(statementChanged ? (["statement"] as const) : []),
      ...(kind !== row.kind ? (["kind"] as const) : []),
      ...(!sameTags(tags, row.tags) ? (["tags"] as const) : []),
      ...(asOf !== row.as_of ? (["as_of"] as const) : []),
    ];
    const version = statementChanged
      ? await appendStatement(op, row, statement, checks)
      : row.current_version;
    const asOfSql = op.loc.scope === "portable" ? sql`` : sql`, as_of = ${asOf}::date`;
    const policySql = op.loc.scope === "site" ? sql`, policy = ${policy}` : sql``;
    if (changed.length > 0 || policy !== row.policy)
      await op.tx.execute(sql`
        UPDATE ${op.loc.items} i SET kind = ${kind}, tags = ${textArray(tags)}, updated_at = now()
               ${asOfSql} ${policySql}
         WHERE ${op.loc.where} AND i.id = ${row.id}`);

    const teamId = auditTeam(op.loc);
    const events: ServerAuditEvent[] = [];
    if (changed.length > 0)
      events.push({
        action: "memory.item.updated",
        teamId,
        target: { scope, itemId: row.id, version, previousVersion: row.current_version, changed },
      });
    if (policy !== row.policy)
      events.push({
        action: "memory.policy.set",
        teamId: null,
        target: { itemId: row.id, version, policy },
      });
    events.push(...overrideAuditEvents(checks, { scope, itemId: row.id, version, teamId }));
    const after = { kind, tags, policy, asOf };
    if (scope === "site" && metadataChanged(row, after) && (await siteMemoryHeld(op.tx)))
      events.push(changedUnderHold(row, after, version));
    return finish(op, row.id, events);
  });
}

interface HeldMetadata {
  readonly kind: ItemRow["kind"];
  readonly tags: readonly string[];
  readonly policy: boolean;
  readonly asOf: string | null;
}

const metadataChanged = (row: ItemRow, after: HeldMetadata): boolean =>
  after.kind !== row.kind ||
  !sameTags(after.tags, row.tags) ||
  after.policy !== row.policy ||
  after.asOf !== row.as_of;

const heldSnapshot = (m: HeldMetadata) => ({
  kind: m.kind,
  tagCount: m.tags.length,
  tagsHmac: tagsFingerprint(m.tags),
  policy: m.policy,
  asOf: m.asOf,
});

/**
 * Under a Site-wide hold (KOBE-647, review L3) a change to a Site item's row fields keeps the
 * earlier kind, Policy flag and as-of in the Site audit log (the row has no history of its own);
 * tags only as a count and a keyed fingerprint ({@link tagsFingerprint}), never the values.
 */
function changedUnderHold(row: ItemRow, after: HeldMetadata, version: number): ServerAuditEvent {
  return {
    action: "memory.item.changed_under_hold",
    teamId: null,
    target: {
      itemId: row.id,
      version,
      before: heldSnapshot({ kind: row.kind, tags: row.tags, policy: row.policy, asOf: row.as_of }),
      after: heldSnapshot(after),
    },
  };
}

/** Undo (KOBE-378): a new version copying an earlier one; the earlier one stays. */
export function revertItem(
  db: KobeDb,
  who: MemoryWho,
  scope: Scope,
  id: string,
  body: RevertSemanticMemoryItem,
): Promise<SemanticMemoryItemDetail> {
  return inStore(db, who, scope, async (op) => {
    const row = await prepare(op, id, false);
    if (row.status !== "active") throw inactive();
    assertExpected(row, body.expected_version);
    const { rows } = await op.tx.execute<{ statement: string }>(sql`
      SELECT statement FROM ${op.loc.versions}
       WHERE ${op.loc.versionsOfItem(row.id)} AND version = ${body.version}`);
    const earlier = rows[0];
    if (!earlier) throw invalid(`This memory has no version ${body.version} (any more).`);
    if (row.policy) await assertPolicyBudget(op.tx, [row.id], earlier.statement);
    const checks = await saveChecks(
      op,
      { statement: earlier.statement, policy: row.policy, except: [row.id] },
      body.overrides,
    );
    const version = await appendStatement(op, row, earlier.statement, checks);
    const teamId = auditTeam(op.loc);
    const events: ServerAuditEvent[] = [
      {
        action: "memory.item.reverted",
        teamId,
        target: { scope, itemId: row.id, fromVersion: body.version, version },
      },
    ];
    events.push(...overrideAuditEvents(checks, { scope, itemId: row.id, version, teamId }));
    return finish(op, row.id, events);
  });
}

/** Archive (never deletes; versions stay). Archiving also unpins. Archiving twice is a no-op. */
export function archiveItem(
  db: KobeDb,
  who: MemoryWho,
  scope: Scope,
  id: string,
  body: SemanticMemoryItemAction,
): Promise<SemanticMemoryItemDetail> {
  return inStore(db, who, scope, async (op) => {
    const row = await prepare(op, id, false);
    assertExpected(row, body.expected_version);
    if (row.status === "superseded") throw inactive("Superseded memories stay as history.");
    if (row.status === "archived") return finish(op, row.id, []);
    await op.tx.execute(sql`
      UPDATE ${op.loc.items} i SET status = 'archived', pinned = false, updated_at = now()
       WHERE ${op.loc.where} AND i.id = ${row.id}`);
    return finish(op, row.id, [
      {
        action: "memory.item.archived",
        teamId: auditTeam(op.loc),
        target: { scope, itemId: row.id, version: row.current_version },
      },
    ]);
  });
}

/**
 * Restore from the archive: needs room in the scope (and in Policy for a Policy item), and passes
 * the save checks like a new save (warnings and Policy conflicts need the body's `overrides`).
 */
export function restoreItem(
  db: KobeDb,
  who: MemoryWho,
  scope: Scope,
  id: string,
  body: RestoreSemanticMemoryItem,
): Promise<SemanticMemoryItemDetail> {
  return inStore(db, who, scope, async (op) => {
    const row = await prepare(op, id, false);
    assertExpected(row, body.expected_version);
    if (row.status === "superseded")
      throw inactive("Superseded memories stay as history; save a new one instead.");
    if (row.status === "active") return finish(op, row.id, []);
    await lockScope(op.tx, op.loc);
    const before = await assertRoom(op.tx, op.loc, op.settings, 1);
    if (row.policy) await assertPolicyBudget(op.tx, [row.id], row.statement);
    // Restoring puts the text back in the agent's context: every save check runs, against
    // today's Policy, rules and egress (KOBE-379 review H-1), with the body's overrides.
    const checks = await saveChecks(
      op,
      { statement: row.statement, policy: row.policy, except: [row.id], tags: row.tags },
      body.overrides,
    );
    await op.tx.execute(sql`
      UPDATE ${op.loc.items} i SET status = 'active', updated_at = now()
       WHERE ${op.loc.where} AND i.id = ${row.id}`);
    op.pending = await notifyNearFull(op.tx, op.loc, op.settings, before, before + 1);
    const teamId = auditTeam(op.loc);
    const at = { scope, itemId: row.id, version: row.current_version, teamId };
    return finish(op, row.id, [
      {
        action: "memory.item.restored",
        teamId,
        target: { scope, itemId: row.id, version: row.current_version },
      },
      ...overrideAuditEvents(checks, at),
    ]);
  });
}

/** Pin or unpin: at most 10 pinned active items per scope; Policy is never pinned. */
export function pinItem(
  db: KobeDb,
  who: MemoryWho,
  scope: Scope,
  id: string,
  body: PinSemanticMemoryItem,
): Promise<SemanticMemoryItemDetail> {
  return inStore(db, who, scope, async (op) => {
    const row = await prepare(op, id, false);
    if (row.status !== "active") throw inactive();
    assertExpected(row, body.expected_version);
    if (body.pinned && row.policy) throw notPinnable();
    if (body.pinned === row.pinned) return finish(op, row.id, []);
    if (body.pinned) {
      await lockScope(op.tx, op.loc);
      await assertPinRoom(op.tx, op.loc, row.id);
    }
    await op.tx.execute(sql`
      UPDATE ${op.loc.items} i SET pinned = ${body.pinned}, updated_at = now()
       WHERE ${op.loc.where} AND i.id = ${row.id}`);
    return finish(op, row.id, [
      {
        action: body.pinned ? "memory.item.pinned" : "memory.item.unpinned",
        teamId: auditTeam(op.loc),
        target: { scope, itemId: row.id },
      },
    ]);
  });
}
