import { sql, type KobeDb } from "@kobe/db";
import type { CreateSemanticMemoryItem, SemanticMemoryItemDetail } from "@kobe/protocol";
import type { ServerAuditEvent } from "../../audit/record.js";
import {
  audit,
  auditTeam,
  inStore,
  loadForWrite,
  normaliseTags,
  saveChecks,
  textArray,
  type Op,
} from "./context.js";
import { inactive, invalid } from "./errors.js";
import {
  assertPinRoom,
  assertPolicyBudget,
  assertRoom,
  lockScope,
  notifyNearFull,
} from "./limits.js";
import { workspaceTeam } from "./location.js";
import { detailOf, readItem, type ItemRow } from "./rows.js";
import { insertVersion } from "./versions.js";
import { assertEnabled, assertMayWrite, type MemoryWho } from "./who.js";

/**
 * Save a new item (KOBE-378): switches, rights (the Policy guard for any `policy` in the body),
 * the replaced item when superseding, scope room (blocks at 100%, never evicts), pin room, the
 * Policy budget, the near-duplicate check, then the item and its version 1 in one transaction.
 */
export function createItem(
  db: KobeDb,
  who: MemoryWho,
  body: CreateSemanticMemoryItem,
): Promise<SemanticMemoryItemDetail> {
  return inStore(db, who, body.scope, async (op) => {
    const policy = body.policy === true;
    assertEnabled(op.memory, body.scope, policy);
    assertMayWrite(who, body.scope, {
      policyField: body.policy !== undefined,
      targetIsPolicy: false,
    });
    const replaced = body.supersedes_id ? await replacedItem(op, body.supersedes_id) : undefined;
    if (body.source_thread_id) await assertThreadInWorkspace(op, body.source_thread_id);

    await lockScope(op.tx, op.loc);
    const before = await assertRoom(op.tx, op.loc, op.settings, replaced ? 0 : 1);
    if (body.pinned === true) await assertPinRoom(op.tx, op.loc);
    const retired = replaced?.policy ? [replaced.id] : [];
    if (policy) await assertPolicyBudget(op.tx, retired, body.statement);
    const checks = await saveChecks(
      op,
      body.statement,
      body.overrides,
      replaced ? [replaced.id] : [],
    );

    const id = await insertItem(op, body, policy);
    await insertVersion(op.tx, op.loc, {
      itemId: id,
      version: 1,
      statement: body.statement,
      actorKind: "user",
      lintOverride: checks.lintOverride,
      policyOverride: false,
      sourceThreadId: body.source_thread_id,
      sourceEntryIds: body.source_entry_ids,
    });
    if (replaced) {
      await op.tx.execute(sql`
        UPDATE ${op.loc.items} i SET status = 'superseded', superseded_by = ${id}, updated_at = now()
         WHERE ${op.loc.where} AND i.id = ${replaced.id}`);
    }
    op.pending = await notifyNearFull(
      op.tx,
      op.loc,
      op.settings,
      before,
      before + (replaced ? 0 : 1),
    );

    const teamId = auditTeam(op.loc);
    const scope = body.scope;
    const events: ServerAuditEvent[] = [
      {
        action: "memory.item.created",
        teamId,
        target: {
          scope,
          itemId: id,
          kind: body.kind,
          version: 1,
          actorKind: "user",
          pinned: body.pinned === true,
          policy,
        },
      },
    ];
    if (replaced)
      events.push({
        action: "memory.item.superseded",
        teamId,
        target: { scope, itemId: replaced.id, supersededBy: id },
      });
    if (checks.lintOverride)
      events.push({
        action: "memory.lint.override",
        teamId,
        target: { scope, itemId: id, version: 1, warnings: checks.warnings },
      });
    const row = await readItem(op.tx, op.loc, id);
    if (!row) throw new Error("memory item vanished inside its own transaction");
    const detail = await detailOf(op.tx, op.loc, who, row);
    await audit(op, events);
    return detail;
  });
}

/** The active item a save replaces: same scope, and the caller may change it. */
async function replacedItem(op: Op, id: string): Promise<ItemRow> {
  const row = await loadForWrite(op, id);
  assertMayWrite(op.who, op.loc.scope, { policyField: false, targetIsPolicy: row.policy });
  if (row.status !== "active") throw inactive("The memory to replace is not active.");
  return row;
}

/** A source thread must be a thread of this Workspace (no key on the column; KOBE-376). */
async function assertThreadInWorkspace(op: Op, threadId: string): Promise<void> {
  const { rows } = await op.tx.execute(
    sql`SELECT 1 FROM threads WHERE team_id = ${workspaceTeam(op.loc)} AND id = ${threadId}`,
  );
  if (rows.length === 0) throw invalid("source_thread_id is not a conversation in this workspace.");
}

async function insertItem(
  op: Op,
  body: CreateSemanticMemoryItem,
  policy: boolean,
): Promise<string> {
  const { loc } = op;
  const tags = textArray(normaliseTags(body.tags ?? []));
  const pinned = body.pinned === true;
  const asOf = body.as_of ?? null;
  const insert =
    loc.scope === "user" || loc.scope === "team"
      ? sql`INSERT INTO semantic_memory_items (team_id, scope, owner_user_id, kind, pinned, tags, as_of)
            VALUES (${workspaceTeam(loc)}, ${loc.scope}, ${loc.scope === "user" ? loc.userId : null}, ${body.kind}, ${pinned}, ${tags}, ${asOf}::date)
            RETURNING id`
      : loc.scope === "portable"
        ? sql`INSERT INTO portable_memory_items (owner_user_id, kind, pinned, tags)
              VALUES (${loc.userId}, ${body.kind}, ${pinned}, ${tags}) RETURNING id`
        : sql`INSERT INTO site_memory_items (kind, pinned, tags, policy, as_of)
              VALUES (${body.kind}, ${pinned}, ${tags}, ${policy}, ${asOf}::date) RETURNING id`;
  const { rows } = await op.tx.execute<{ id: string }>(insert);
  const id = rows[0]?.id;
  if (!id) throw new Error("memory item insert returned no id");
  return id;
}
