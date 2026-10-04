import {
  RETENTION_MAXIMUM_KEY,
  RETENTION_MAXIMUM_PENDING_KEY,
  eq,
  inArray,
  installSettings,
  teamRetention,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import { recordAudit } from "../audit/record.js";
import {
  DEFAULT_PERIOD,
  FOREVER_LAYER,
  changeLayer,
  parsePeriod,
  retentionView,
  settle,
  target,
  withinMaximum,
  type Layer,
  type RetentionPeriod,
  type RetentionView,
} from "./periods.js";

/**
 * Where the periods live (D6): the install maximum in `install_settings` (install admins), the
 * team's period in `team_retention` (team admins, behind team RLS). Both default to forever. A
 * shortening of either waits 7 days as a pending change (user decision 2026-10-04), cancellable
 * meanwhile; a lengthening applies at once. Reads settle a pending change whose date has come, so
 * the job never depends on a write happening on time.
 */

type Executor = KobeDb | KobeTx;

/** `<period>@<ISO>` → pending part of a layer; anything malformed means no pending change. */
function parsePending(value: string | undefined): Pick<Layer, "pending" | "pendingAt"> {
  const [period, at] = (value ?? "").split("@");
  const when = at ? new Date(at) : null;
  const parsed = parsePeriod(period);
  if (!when || Number.isNaN(when.getTime()) || parsed !== period) {
    return { pending: null, pendingAt: null };
  }
  return { pending: parsed, pendingAt: when };
}

/** The install maximum's layer (row-locked with `forUpdate`). */
export async function readMaximumLayer(db: Executor, forUpdate = false): Promise<Layer> {
  const query = db
    .select({ key: installSettings.key, value: installSettings.value })
    .from(installSettings)
    .where(inArray(installSettings.key, [RETENTION_MAXIMUM_KEY, RETENTION_MAXIMUM_PENDING_KEY]));
  const rows = await (forUpdate ? query.for("update") : query);
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  return {
    applied: parsePeriod(value(RETENTION_MAXIMUM_KEY) ?? DEFAULT_PERIOD),
    ...parsePending(value(RETENTION_MAXIMUM_PENDING_KEY)),
  };
}

/** The team's layer; call inside the team's `withTeam` transaction. */
export async function readTeamLayer(tx: KobeTx, teamId: string, forUpdate = false): Promise<Layer> {
  const query = tx
    .select({
      period: teamRetention.period,
      pendingPeriod: teamRetention.pendingPeriod,
      pendingAt: teamRetention.pendingAt,
    })
    .from(teamRetention)
    .where(eq(teamRetention.teamId, teamId));
  const [row] = await (forUpdate ? query.for("update") : query);
  if (!row) return FOREVER_LAYER;
  return {
    applied: parsePeriod(row.period),
    pending: row.pendingPeriod === null ? null : parsePeriod(row.pendingPeriod),
    pendingAt: row.pendingAt,
  };
}

export function readRetention(
  db: KobeDb,
  teamId: string,
  now = new Date(),
): Promise<RetentionView> {
  return withTeam(db, teamId, async (tx) =>
    retentionView(await readTeamLayer(tx, teamId), await readMaximumLayer(tx), now),
  );
}

async function writeTeamLayer(
  tx: KobeTx,
  teamId: string,
  userId: string,
  layer: Layer,
): Promise<void> {
  const values = {
    period: layer.applied,
    pendingPeriod: layer.pending,
    pendingAt: layer.pendingAt,
    pendingBy: layer.pending === null ? null : userId,
    updatedBy: userId,
    updatedAt: new Date(),
  };
  await tx
    .insert(teamRetention)
    .values({ teamId, ...values })
    .onConflictDoUpdate({ target: teamRetention.teamId, set: values });
}

export type SetTeamPeriodResult =
  | {
      readonly ok: true;
      readonly view: RetentionView;
      /** A shortening was scheduled (the caller notifies the team admins). */
      readonly scheduled: boolean;
    }
  | { readonly ok: false; readonly error: "exceeds_maximum"; readonly maximum: RetentionPeriod };

/**
 * Sets the team's period (team admins), within the install maximum as chosen. A shorter period is
 * scheduled 7 days out; a longer one applies at once (and drops a pending shortening). Audited
 * (`retention.policy.changed`, with `effectiveAt` when scheduled).
 */
export function setTeamPeriod(
  db: KobeDb,
  teamId: string,
  userId: string,
  period: RetentionPeriod,
  now = new Date(),
): Promise<SetTeamPeriodResult> {
  return withTeam(db, teamId, async (tx) => {
    const maximum = await readMaximumLayer(tx);
    const cap = target(settle(maximum, now));
    if (!withinMaximum(period, cap)) return { ok: false, error: "exceeds_maximum", maximum: cap };
    const before = await readTeamLayer(tx, teamId, true);
    const change = changeLayer(before, period, now);
    if (change.kind !== "unchanged") {
      await writeTeamLayer(tx, teamId, userId, change.layer);
      await recordAudit(tx, {
        action: "retention.policy.changed",
        teamId,
        target: {
          period,
          previous: target(settle(before, now)),
          ...(change.layer.pendingAt ? { effectiveAt: change.layer.pendingAt.toISOString() } : {}),
        },
      });
    }
    return {
      ok: true,
      view: retentionView(change.layer, maximum, now),
      scheduled: change.kind === "scheduled",
    };
  });
}

/** Cancels the team's pending shortening (team admins); false when there is none. */
export function cancelTeamPending(
  db: KobeDb,
  teamId: string,
  userId: string,
  now = new Date(),
): Promise<RetentionView | null> {
  return withTeam(db, teamId, async (tx) => {
    const layer = settle(await readTeamLayer(tx, teamId, true), now);
    if (layer.pending === null) return null;
    const kept: Layer = { applied: layer.applied, pending: null, pendingAt: null };
    await writeTeamLayer(tx, teamId, userId, kept);
    await recordAudit(tx, {
      action: "retention.policy.change_cancelled",
      teamId,
      target: { period: layer.pending, kept: layer.applied },
    });
    return retentionView(kept, await readMaximumLayer(tx), now);
  });
}

export interface MaximumView {
  /** The maximum as chosen (in force or pending). */
  readonly maximum: RetentionPeriod;
  /** In force now. */
  readonly applied: RetentionPeriod;
  readonly pending: { readonly maximum: RetentionPeriod; readonly effectiveAt: string } | null;
}

export function maximumView(layer: Layer, now: Date): MaximumView {
  const m = settle(layer, now);
  return {
    maximum: target(m),
    applied: m.applied,
    pending:
      m.pending !== null && m.pendingAt !== null
        ? { maximum: m.pending, effectiveAt: m.pendingAt.toISOString() }
        : null,
  };
}

export async function readMaximum(db: Executor, now = new Date()): Promise<MaximumView> {
  return maximumView(await readMaximumLayer(db), now);
}

/** Upserts an install setting (the app role can't delete them: "" means none). */
async function store(tx: KobeTx, key: string, value: string): Promise<void> {
  await tx
    .insert(installSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: installSettings.key, set: { value, updatedAt: new Date() } });
}

async function writeMaximumLayer(tx: KobeTx, layer: Layer): Promise<void> {
  await store(tx, RETENTION_MAXIMUM_KEY, layer.applied);
  await store(
    tx,
    RETENTION_MAXIMUM_PENDING_KEY,
    layer.pending !== null && layer.pendingAt !== null
      ? `${layer.pending}@${layer.pendingAt.toISOString()}`
      : "",
  );
}

/**
 * Sets the install maximum (install admins). Lowering it is scheduled 7 days out (teams keep their
 * choices; the job applies the shorter); raising it applies at once. Audited
 * (`retention.maximum.changed`, with `effectiveAt` when scheduled).
 */
export function setMaximum(
  db: KobeDb,
  maximum: RetentionPeriod,
  now = new Date(),
): Promise<{ view: MaximumView; scheduled: boolean }> {
  return db.transaction(async (tx) => {
    const before = await readMaximumLayer(tx, true);
    const change = changeLayer(before, maximum, now);
    if (change.kind !== "unchanged") {
      await writeMaximumLayer(tx, change.layer);
      await recordAudit(tx, {
        action: "retention.maximum.changed",
        target: {
          maximum,
          previous: target(settle(before, now)),
          ...(change.layer.pendingAt ? { effectiveAt: change.layer.pendingAt.toISOString() } : {}),
        },
      });
    }
    return { view: maximumView(change.layer, now), scheduled: change.kind === "scheduled" };
  });
}

/** Cancels a pending lowering of the maximum; null when there is none. */
export function cancelMaximumPending(db: KobeDb, now = new Date()): Promise<MaximumView | null> {
  return db.transaction(async (tx) => {
    const layer = settle(await readMaximumLayer(tx, true), now);
    if (layer.pending === null) return null;
    const kept: Layer = { applied: layer.applied, pending: null, pendingAt: null };
    await writeMaximumLayer(tx, kept);
    await recordAudit(tx, {
      action: "retention.maximum.change_cancelled",
      target: { maximum: layer.pending, kept: layer.applied },
    });
    return maximumView(kept, now);
  });
}
