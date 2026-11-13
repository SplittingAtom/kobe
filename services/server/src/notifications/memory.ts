import type { NotificationKind } from "@kobe/protocol";
import { sql, teams, withTeam, type KobeDb, type KobeTx } from "@kobe/db";
import type { Logger } from "pino";
import { logger } from "../logger.js";
import type { ReconcileLock } from "../sandbox/reconcile-lock.js";

/**
 * Memory notifications (KOBE-645, v1.3 Semantic Memory SM22): the one way semantic memory tells
 * people something in the bell. Sources call three functions, inside their own `withTeam()`
 * transaction so the notice commits with the change:
 *
 * - {@link notifyMemory} (or {@link notifyMemoryAll} for several notices in one transaction):
 *   one notification per recipient. More than {@link MEMORY_DIGEST_AFTER}
 *   of one kind for one recipient within {@link MEMORY_DIGEST_WINDOW_MINUTES} minutes roll into one
 *   `memory.review.digest` (the first five stay notifications of their own; the digest counts the
 *   rest and turns unread again as it grows).
 * - {@link registerMemoryReminder}: a pending object (a Workspace proposal, KOBE-397; a Site
 *   proposal, KOBE-403; a reader's suggestion, KOBE-652; candidates waiting in To review) owes
 *   each recipient one `memory.review.reminder` after {@link MEMORY_REMINDER_DAYS} days.
 * - {@link settleMemoryReminders}: the object was decided (or withdrawn); no reminder is owed.
 *
 * Contract for callers: notify **last** in the transaction (the digest lock per recipient and kind
 * is held until commit, so slow work after it serialises that recipient's notices of that kind);
 * pass several notices of one transaction to one {@link notifyMemoryAll} call (locks are taken in
 * one order there; separate calls in opposite orders can deadlock). The actor must be a member of
 * the Workspace (a Site curator for a Site decision), and a candidates_ready thread the
 * recipient's own: anything else throws. A source that deletes an object settles its reminders.
 *
 * {@link MemoryReminderJob} sends due reminders on one replica at a time (session advisory lock
 * {@link MEMORY_REMINDER_LOCK}, like the other periodic jobs); rows are also claimed with SKIP
 * LOCKED, so even an overlapping pass sends each reminder once. At send the recipient's right to
 * decide is checked again (curator for a Workspace proposal, project editor or owner or Team admin
 * for a suggestion, Team admin for a Site proposal at step 1, Site admin or steward at step 2); a
 * reminder whose recipient lost it is dropped. A failing team is logged and skipped: the other
 * teams' reminders still go out, and its own on the next pass. Ids and names only, never memory
 * text: the bell links to where the person decides.
 */

export const MEMORY_DIGEST_AFTER = 5;
export const MEMORY_DIGEST_WINDOW_MINUTES = 60;
export const MEMORY_REMINDER_DAYS = 7;
export const MEMORY_REMINDER_LOCK = "kobe.memory-reminders";
export const MEMORY_REMINDER_SWEEP_MS = 15 * 60_000;
/** Due reminders one team's pass sends at most; the rest wait for the next pass. */
const SWEEP_BATCH = 200;

/** The kinds of a pending object a reminder can be about (null: To review candidates). */
export type MemoryPendingKind =
  | "memory.proposal.received"
  | "memory.suggestion.received"
  | "memory.site_proposal.received"
  | "memory.site_proposal.confirmed"
  | "memory.site_proposal.changes_requested";

type ProposalKind =
  | "memory.proposal.received"
  | "memory.proposal.accepted"
  | "memory.proposal.dismissed"
  | "memory.proposal.changes_requested"
  | "memory.proposal.expired"
  | "memory.site_proposal.received"
  | "memory.site_proposal.confirmed"
  | "memory.site_proposal.changes_requested"
  | "memory.site_proposal.accepted"
  | "memory.site_proposal.dismissed"
  | "memory.site_proposal.expired";
type SuggestionKind =
  | "memory.suggestion.received"
  | "memory.suggestion.accepted"
  | "memory.suggestion.dismissed"
  | "memory.suggestion.expired";

/** What to tell: each kind with exactly the fields it names (the DB check mirrors this). */
export type MemoryNotice =
  | { readonly kind: "memory.scope.near_full"; readonly scope: "team" | "site" }
  | {
      /** A learning pass left `count` candidates in To review (the panel did not open). */
      readonly kind: "memory.review.candidates_ready";
      readonly threadId: string;
      readonly count: number;
      readonly passId?: string;
    }
  | {
      readonly kind: ProposalKind;
      readonly objectId: string;
      /** Who submitted, confirmed or decided (none on expiry). */
      readonly actorUserId?: string;
    }
  | {
      readonly kind: SuggestionKind;
      readonly objectId: string;
      readonly projectId: string;
      readonly actorUserId?: string;
    }
  | {
      readonly kind: "memory.review.reminder";
      readonly objectId: string;
      readonly about: MemoryPendingKind | null;
      /** Required when `about` is a suggestion. */
      readonly projectId?: string;
    };

export interface MemoryNotifyResult {
  readonly userId: string;
  /** `notified`: a notification of its own; `digested`: counted in the recipient's digest. */
  readonly outcome: "notified" | "digested";
  readonly notificationId: string;
}

const lockKey = (teamId: string, userId: string, kind: NotificationKind) =>
  `kobe.memory-digest:${teamId}:${userId}:${kind}`;

const fieldsOf = (n: MemoryNotice) => ({
  memoryScope: n.kind === "memory.scope.near_full" ? n.scope : null,
  objectId: "objectId" in n ? n.objectId : "passId" in n ? (n.passId ?? null) : null,
  threadId: n.kind === "memory.review.candidates_ready" ? n.threadId : null,
  itemCount: n.kind === "memory.review.candidates_ready" ? n.count : null,
  relatedKind: n.kind === "memory.review.reminder" ? n.about : null,
  projectId: "projectId" in n ? (n.projectId ?? null) : null,
  actorUserId: "actorUserId" in n ? (n.actorUserId ?? null) : null,
});

/**
 * Tells each recipient `notice` in `tx` (a `withTeam(teamId)` transaction). Recipients who are
 * not active members of the team are skipped (not in the result). Serialised per recipient and
 * kind (transaction advisory lock), so concurrent notices roll up exactly.
 */
export async function notifyMemory(
  tx: KobeTx,
  teamId: string,
  recipients: readonly string[],
  notice: MemoryNotice,
): Promise<MemoryNotifyResult[]> {
  return notifyMemoryAll(tx, teamId, [{ recipients, notice }]);
}

export interface MemoryNoticeFor {
  readonly recipients: readonly string[];
  readonly notice: MemoryNotice;
}

/**
 * Several notices in one transaction: validates them all, then takes the digest locks in one
 * order (kind, then recipient), so two transactions notifying the same people of the same kinds
 * in different orders cannot deadlock.
 */
export async function notifyMemoryAll(
  tx: KobeTx,
  teamId: string,
  items: readonly MemoryNoticeFor[],
): Promise<MemoryNotifyResult[]> {
  const pairs: { readonly userId: string; readonly notice: MemoryNotice }[] = [];
  for (const { recipients, notice } of items) {
    await assertActor(tx, teamId, notice);
    for (const userId of new Set(recipients)) {
      await assertThread(tx, teamId, userId, notice);
      pairs.push({ userId, notice });
    }
  }
  pairs.sort((a, b) =>
    a.notice.kind === b.notice.kind
      ? a.userId.localeCompare(b.userId)
      : a.notice.kind.localeCompare(b.notice.kind),
  );
  const out: MemoryNotifyResult[] = [];
  for (const { userId, notice } of pairs) {
    const r = await notifyOne(tx, teamId, userId, notice);
    if (r) out.push(r);
  }
  return out;
}

/** Site decisions are made by Site curators, who need not be members of the Workspace. */
const SITE_DECISIONS: readonly string[] = [
  "memory.site_proposal.accepted",
  "memory.site_proposal.dismissed",
  "memory.site_proposal.changes_requested",
];

const siteCurator = (userId: string) => sql`(
  EXISTS (SELECT 1 FROM site_roles WHERE user_id = ${userId})
  OR EXISTS (SELECT 1 FROM site_grants WHERE user_id = ${userId} AND "grant" = 'memory_steward'))`;

async function assertActor(tx: KobeTx, teamId: string, n: MemoryNotice): Promise<void> {
  const actor = "actorUserId" in n ? n.actorUserId : undefined;
  if (actor === undefined) return;
  const member = sql`EXISTS (SELECT 1 FROM team_members WHERE team_id = ${teamId} AND user_id = ${actor})`;
  const allowed = SITE_DECISIONS.includes(n.kind)
    ? sql`(${member} OR ${siteCurator(actor)})`
    : member;
  const { rows } = await tx.execute<{ ok: boolean }>(sql`SELECT ${allowed} AS ok`);
  if (rows[0]?.ok !== true) {
    throw new Error(`memory notification actor is not in the Workspace (${n.kind})`);
  }
}

async function assertThread(
  tx: KobeTx,
  teamId: string,
  userId: string,
  n: MemoryNotice,
): Promise<void> {
  if (n.kind !== "memory.review.candidates_ready") return;
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM threads WHERE team_id = ${teamId} AND id = ${n.threadId}
       AND owner_user_id = ${userId}`);
  if (rows.length === 0) {
    throw new Error("memory notification thread is not the recipient's own thread");
  }
}

/**
 * Whether `userId` may still decide the pending object of a reminder (review M1): the right is
 * checked at send, not only at registration.
 */
async function mayDecide(
  tx: KobeTx,
  teamId: string,
  userId: string,
  about: MemoryPendingKind | null,
  projectId: string | null,
): Promise<boolean> {
  const teamAdmin = sql`EXISTS (SELECT 1 FROM team_members
    WHERE team_id = ${teamId} AND user_id = ${userId} AND role = 'team_admin')`;
  let right;
  switch (about) {
    case null:
      return true; // the candidates' own author (membership is checked when notifying)
    case "memory.proposal.received":
      right = sql`(${teamAdmin} OR EXISTS (SELECT 1 FROM memory_stewards
        WHERE team_id = ${teamId} AND user_id = ${userId}))`;
      break;
    case "memory.suggestion.received":
      right = sql`(${teamAdmin} OR EXISTS (SELECT 1 FROM project_members
        WHERE team_id = ${teamId} AND project_id = ${projectId} AND user_id = ${userId}
          AND role IN ('owner', 'editor')))`;
      break;
    case "memory.site_proposal.received":
    case "memory.site_proposal.changes_requested":
      right = teamAdmin;
      break;
    case "memory.site_proposal.confirmed":
      right = siteCurator(userId);
      break;
  }
  const { rows } = await tx.execute<{ ok: boolean }>(sql`SELECT ${right} AS ok`);
  return rows[0]?.ok === true;
}

async function isActiveMember(tx: KobeTx, teamId: string, userId: string): Promise<boolean> {
  const { rows } = await tx.execute(sql`
    SELECT 1 FROM team_members tm JOIN users u ON u.id = tm.user_id AND u.deactivated_at IS NULL
     WHERE tm.team_id = ${teamId} AND tm.user_id = ${userId}`);
  return rows.length > 0;
}

async function notifyOne(
  tx: KobeTx,
  teamId: string,
  userId: string,
  n: MemoryNotice,
): Promise<MemoryNotifyResult | null> {
  if (!(await isActiveMember(tx, teamId, userId))) return null;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(teamId, userId, n.kind)}, 0))`,
  );
  const window = sql`now() - make_interval(mins => ${MEMORY_DIGEST_WINDOW_MINUTES})`;
  const grown = await tx.execute<{ id: string }>(sql`
    UPDATE notifications SET item_count = item_count + 1, read_at = NULL
     WHERE team_id = ${teamId} AND id = (
       SELECT id FROM notifications
        WHERE team_id = ${teamId} AND user_id = ${userId} AND kind = 'memory.review.digest'
          AND related_kind = ${n.kind} AND created_at > ${window}
        ORDER BY created_at DESC LIMIT 1)
     RETURNING id`);
  const open = grown.rows[0];
  if (open) return { userId, outcome: "digested", notificationId: open.id };
  const recent = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM notifications
     WHERE team_id = ${teamId} AND user_id = ${userId} AND kind = ${n.kind}
       AND created_at > ${window}`);
  if ((recent.rows[0]?.n ?? 0) >= MEMORY_DIGEST_AFTER) {
    const digest = await tx.execute<{ id: string }>(sql`
      INSERT INTO notifications (team_id, user_id, kind, related_kind, item_count)
      VALUES (${teamId}, ${userId}, 'memory.review.digest', ${n.kind}, 1)
      RETURNING id`);
    return { userId, outcome: "digested", notificationId: must(digest.rows[0]).id };
  }
  const f = fieldsOf(n);
  const inserted = await tx.execute<{ id: string }>(sql`
    INSERT INTO notifications (team_id, user_id, kind, memory_scope, memory_object_id,
                               related_kind, project_id, actor_user_id, thread_id, item_count)
    VALUES (${teamId}, ${userId}, ${n.kind}, ${f.memoryScope}, ${f.objectId}, ${f.relatedKind},
            ${f.projectId}, ${f.actorUserId}, ${f.threadId}, ${f.itemCount})
    RETURNING id`);
  return { userId, outcome: "notified", notificationId: must(inserted.rows[0]).id };
}

function must<T>(row: T | undefined): T {
  if (row === undefined) throw new Error("memory notification insert returned nothing");
  return row;
}

export interface MemoryReminderInput {
  readonly objectId: string;
  /** What the object is; null for candidates waiting in To review. */
  readonly about: MemoryPendingKind | null;
  /** Required for a suggestion: the project whose notes it is for. */
  readonly projectId?: string;
  /** Who decides it (curators, editors, the candidate's author). Non-members are skipped. */
  readonly recipients: readonly string[];
}

/**
 * Registers a pending object for one reminder per recipient {@link MEMORY_REMINDER_DAYS} days
 * from now, in the source's `withTeam(teamId)` transaction. Idempotent: registering an object a
 * recipient already has a row for changes nothing (so a sent reminder is never sent again).
 */
export async function registerMemoryReminder(
  tx: KobeTx,
  teamId: string,
  input: MemoryReminderInput,
): Promise<void> {
  for (const userId of new Set(input.recipients)) {
    await tx.execute(sql`
      INSERT INTO memory_reminders (team_id, object_id, related_kind, user_id, project_id, due_at)
      SELECT ${teamId}, ${input.objectId}, ${input.about}, ${userId}, ${input.projectId ?? null},
             now() + make_interval(days => ${MEMORY_REMINDER_DAYS})
        FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}
      ON CONFLICT DO NOTHING`);
  }
}

/** The object was decided or withdrawn: drops its reminders (sent or not). */
export async function settleMemoryReminders(
  tx: KobeTx,
  teamId: string,
  objectId: string,
): Promise<number> {
  const res = await tx.execute(sql`
    DELETE FROM memory_reminders WHERE team_id = ${teamId} AND object_id = ${objectId}`);
  return res.rowCount ?? 0;
}

async function sweepTeam(db: KobeDb, teamId: string): Promise<number> {
  return withTeam(db, teamId, async (tx) => {
    const { rows } = await tx.execute<{
      id: string;
      object_id: string;
      related_kind: MemoryPendingKind | null;
      user_id: string;
      project_id: string | null;
    }>(sql`
      SELECT id, object_id, related_kind, user_id, project_id FROM memory_reminders
       WHERE team_id = ${teamId} AND sent_at IS NULL AND due_at <= now()
       ORDER BY due_at LIMIT ${SWEEP_BATCH}
       FOR UPDATE SKIP LOCKED`);
    // By recipient: an overlapping pass takes the per-recipient locks in the same order.
    const byUser = [...rows].sort((x, y) => x.user_id.localeCompare(y.user_id));
    const dropped: string[] = [];
    for (const r of byUser) {
      if (!(await mayDecide(tx, teamId, r.user_id, r.related_kind, r.project_id))) {
        dropped.push(r.id);
        continue;
      }
      await notifyOne(tx, teamId, r.user_id, {
        kind: "memory.review.reminder",
        objectId: r.object_id,
        about: r.related_kind,
        ...(r.project_id ? { projectId: r.project_id } : {}),
      });
    }
    const idList = (ids: readonly string[]) =>
      sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
    const sent = rows.filter((r) => !dropped.includes(r.id)).map((r) => r.id);
    if (sent.length > 0) {
      await tx.execute(sql`
        UPDATE memory_reminders SET sent_at = now()
         WHERE team_id = ${teamId} AND id IN (${idList(sent)})`);
    }
    if (dropped.length > 0) {
      await tx.execute(sql`
        DELETE FROM memory_reminders WHERE team_id = ${teamId} AND id IN (${idList(dropped)})`);
    }
    return sent.length;
  });
}

/**
 * Sends every team's due reminders once; returns how many were sent (or digested). A team whose
 * pass fails is logged and skipped (its reminders stay owed); the others still run.
 */
export async function sweepMemoryReminders(db: KobeDb): Promise<number> {
  const all = await db.select({ id: teams.id }).from(teams);
  let sent = 0;
  for (const { id } of all) {
    try {
      sent += await sweepTeam(db, id);
    } catch (err) {
      logger.error({ err, team_id: id }, "memory reminders: team pass failed");
    }
  }
  return sent;
}

/** The reminder pass on a timer, one replica at a time under `lock`. */
export class MemoryReminderJob {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly o: {
      readonly db: KobeDb;
      readonly lock: ReconcileLock;
      readonly logger: Logger;
      readonly everyMs?: number;
    },
  ) {}

  /** One pass if no other replica runs one: `{ ran: false }` otherwise. */
  async runOnce(): Promise<{ readonly ran: boolean; readonly sent: number }> {
    const outcome = await this.o.lock.runExclusive(() => sweepMemoryReminders(this.o.db));
    if (!outcome.ran) return { ran: false, sent: 0 };
    if (outcome.value > 0) this.o.logger.info({ sent: outcome.value }, "memory reminders sent");
    return { ran: true, sent: outcome.value };
  }

  start(): void {
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.runOnce()
        .catch((err: unknown) => this.o.logger.error({ err }, "memory reminder pass failed"))
        .finally(() => {
          this.running = false;
        });
    };
    run();
    this.timer ??= setInterval(run, this.o.everyMs ?? MEMORY_REMINDER_SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
