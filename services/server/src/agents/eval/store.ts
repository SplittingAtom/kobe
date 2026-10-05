import {
  DEFAULT_EVAL_MAX_ASR,
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  orbitEvals,
  SYSTEM_ACTOR,
  teamEvalSettings,
  withTeam,
  ACTIVE_EVAL_STATUSES,
  type KobeDb,
  type OrbitEvalStatus,
} from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import type { Verdict } from "./judge.js";

/**
 * Eval settings and the eval state machine (KOBE-93).
 *
 *   pending --markRunning--> running --finish--> passed | blocked | errored
 *   pending --finish(errored)--> errored          (the Job could not be created)
 *
 * Transitions are conditional updates, so two replicas (or a sweeper racing the driver) cannot
 * finish an eval twice: the loser sees `null`. A finished eval never changes again; a retry is a
 * new row, and the unique index allows only one unfinished eval per agent.
 */

export interface EvalSettings {
  readonly enabled: boolean;
  /** Publish is blocked when the attack success rate is above this (0 to 1). */
  readonly maxAttackSuccessRate: number;
}

export const DEFAULT_EVAL_SETTINGS: EvalSettings = {
  enabled: false,
  maxAttackSuccessRate: DEFAULT_EVAL_MAX_ASR,
};

export interface EvalRecord {
  readonly id: string;
  readonly teamId: string;
  readonly agentId: string;
  readonly agentScope: "team" | "personal";
  readonly agentSlug: string;
  readonly requestedBy: string;
  readonly draftRevision: number;
  readonly definition: Record<string, unknown>;
  readonly model: string;
  readonly status: OrbitEvalStatus;
  readonly threshold: number;
  readonly attackSuccessRate: number | null;
  readonly attempts: number | null;
  readonly attackSuccesses: number | null;
  readonly report: Record<string, unknown> | null;
  readonly error: string | null;
  readonly version: number | null;
  /** Set when the eval gates a rollback: the version restored if it passes. */
  readonly rollbackFrom: number | null;
  readonly toolManifest: Record<string, unknown> | null;
  readonly jobName: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

const COLUMNS = {
  id: orbitEvals.id,
  teamId: orbitEvals.teamId,
  agentId: orbitEvals.agentId,
  agentScope: orbitEvals.agentScope,
  agentSlug: orbitEvals.agentSlug,
  requestedBy: orbitEvals.requestedBy,
  draftRevision: orbitEvals.draftRevision,
  definition: orbitEvals.definition,
  model: orbitEvals.model,
  status: orbitEvals.status,
  threshold: orbitEvals.threshold,
  attackSuccessRate: orbitEvals.attackSuccessRate,
  attempts: orbitEvals.attempts,
  attackSuccesses: orbitEvals.attackSuccesses,
  report: orbitEvals.report,
  error: orbitEvals.error,
  version: orbitEvals.version,
  rollbackFrom: orbitEvals.rollbackFrom,
  toolManifest: orbitEvals.toolManifest,
  jobName: orbitEvals.jobName,
  createdAt: orbitEvals.createdAt,
  startedAt: orbitEvals.startedAt,
  finishedAt: orbitEvals.finishedAt,
};

const ACTIVE = [...ACTIVE_EVAL_STATUSES];

export function readEvalSettings(db: KobeDb, teamId: string): Promise<EvalSettings> {
  return withTeam(db, teamId, async (tx) => {
    const [row] = await tx
      .select({
        enabled: teamEvalSettings.enabled,
        maxAttackSuccessRate: teamEvalSettings.maxAttackSuccessRate,
      })
      .from(teamEvalSettings)
      .where(eq(teamEvalSettings.teamId, teamId));
    return row ?? DEFAULT_EVAL_SETTINGS;
  });
}

/** Changes the gate switch and/or threshold; a real change is audited. Returns the settings in force. */
export function setEvalSettings(
  db: KobeDb,
  teamId: string,
  userId: string,
  change: {
    readonly enabled?: boolean | undefined;
    readonly maxAttackSuccessRate?: number | undefined;
  },
): Promise<EvalSettings> {
  return withTeam(db, teamId, async (tx) => {
    const [row] = await tx
      .select({
        enabled: teamEvalSettings.enabled,
        maxAttackSuccessRate: teamEvalSettings.maxAttackSuccessRate,
      })
      .from(teamEvalSettings)
      .where(eq(teamEvalSettings.teamId, teamId));
    const current = row ?? DEFAULT_EVAL_SETTINGS;
    const next: EvalSettings = {
      enabled: change.enabled ?? current.enabled,
      maxAttackSuccessRate: change.maxAttackSuccessRate ?? current.maxAttackSuccessRate,
    };
    if (
      next.enabled === current.enabled &&
      next.maxAttackSuccessRate === current.maxAttackSuccessRate
    ) {
      return current;
    }
    await tx
      .insert(teamEvalSettings)
      .values({ teamId, ...next, updatedBy: userId })
      .onConflictDoUpdate({
        target: teamEvalSettings.teamId,
        set: { ...next, updatedBy: userId, updatedAt: new Date() },
      });
    await recordAudit(tx, { action: "agent.eval.settings_changed", teamId, target: next });
    return next;
  });
}

export interface NewEval {
  readonly teamId: string;
  readonly agentId: string;
  readonly agentScope: "team" | "personal";
  readonly agentSlug: string;
  readonly requestedBy: string;
  readonly draftRevision: number;
  readonly definition: Record<string, unknown>;
  readonly model: string;
  readonly threshold: number;
  readonly rollbackFrom?: number;
  readonly toolManifest?: Record<string, unknown>;
}

/** A new `pending` eval; `eval_in_progress` when the agent has an unfinished one. */
export function createEval(
  db: KobeDb,
  input: NewEval,
): Promise<{ ok: true; value: EvalRecord } | { ok: false; error: "eval_in_progress" }> {
  return withTeam(db, input.teamId, async (tx) => {
    const [row] = await tx
      .insert(orbitEvals)
      .values(input)
      .onConflictDoNothing()
      .returning(COLUMNS);
    if (!row) return { ok: false, error: "eval_in_progress" } as const;
    await recordAudit(tx, {
      actor: { kind: "user", id: input.requestedBy },
      action: "agent.eval.requested",
      teamId: input.teamId,
      target: {
        agentId: input.agentId,
        scope: input.agentScope,
        slug: input.agentSlug,
        evalId: row.id,
        draftRevision: input.draftRevision,
      },
    });
    return { ok: true, value: row } as const;
  });
}

/** pending -> running (the Job exists); false when the eval is no longer pending. */
export function markRunning(
  db: KobeDb,
  teamId: string,
  id: string,
  jobName: string,
): Promise<boolean> {
  return withTeam(db, teamId, async (tx) => {
    const rows = await tx
      .update(orbitEvals)
      .set({ status: "running", jobName, startedAt: new Date() })
      .where(and(eq(orbitEvals.id, id), eq(orbitEvals.status, "pending")))
      .returning({ id: orbitEvals.id });
    return rows.length > 0;
  });
}

/**
 * Ends an unfinished eval with `verdict` (audited as a system event). Null when it had already
 * finished, so the first finisher wins and a sweeper cannot overwrite a real result.
 */
export function finishEval(
  db: KobeDb,
  teamId: string,
  id: string,
  verdict: Verdict,
): Promise<EvalRecord | null> {
  return withTeam(db, teamId, async (tx) => {
    const scored = verdict.status === "errored" ? null : verdict;
    const [row] = await tx
      .update(orbitEvals)
      .set({
        status: verdict.status,
        finishedAt: new Date(),
        attackSuccessRate: scored?.attackSuccessRate ?? null,
        attempts: scored?.attempts ?? null,
        attackSuccesses: scored?.attackSuccesses ?? null,
        report: verdict.report ?? null,
        error: verdict.status === "errored" ? verdict.error : null,
      })
      .where(and(eq(orbitEvals.id, id), inArray(orbitEvals.status, ACTIVE)))
      .returning(COLUMNS);
    if (!row) return null;
    await recordAudit(tx, {
      actor: SYSTEM_ACTOR,
      action: "agent.eval.finished",
      teamId,
      target: {
        agentId: row.agentId,
        scope: row.agentScope,
        slug: row.agentSlug,
        evalId: id,
        status: verdict.status,
        attackSuccessRate: row.attackSuccessRate,
      },
    });
    return row;
  });
}

/** Records the version a passed eval published, or why nothing was published. */
export function recordPublication(
  db: KobeDb,
  teamId: string,
  id: string,
  outcome: { readonly version: number } | { readonly note: string },
): Promise<void> {
  return withTeam(db, teamId, async (tx) => {
    await tx
      .update(orbitEvals)
      .set("version" in outcome ? { version: outcome.version } : { error: outcome.note })
      .where(and(eq(orbitEvals.id, id), eq(orbitEvals.status, "passed")));
  });
}

export async function getEval(db: KobeDb, teamId: string, id: string): Promise<EvalRecord | null> {
  return withTeam(db, teamId, async (tx) => {
    const [row] = await tx.select(COLUMNS).from(orbitEvals).where(eq(orbitEvals.id, id));
    return row ?? null;
  });
}

/** An agent's evals, newest first. */
export function listAgentEvals(
  db: KobeDb,
  teamId: string,
  agentId: string,
  limit: number,
): Promise<EvalRecord[]> {
  return withTeam(db, teamId, (tx) =>
    tx
      .select(COLUMNS)
      .from(orbitEvals)
      .where(eq(orbitEvals.agentId, agentId))
      .orderBy(desc(orbitEvals.createdAt))
      .limit(limit),
  );
}

export interface VersionScore {
  readonly evalId: string;
  readonly attackSuccessRate: number;
  readonly threshold: number;
  readonly attempts: number | null;
}

/** The score each published version of the agent earned in this team, by version number. */
export function versionScores(
  db: KobeDb,
  teamId: string,
  agentId: string,
): Promise<ReadonlyMap<number, VersionScore>> {
  return withTeam(db, teamId, async (tx) => {
    const rows = await tx
      .select({
        version: orbitEvals.version,
        evalId: orbitEvals.id,
        attackSuccessRate: orbitEvals.attackSuccessRate,
        threshold: orbitEvals.threshold,
        attempts: orbitEvals.attempts,
      })
      .from(orbitEvals)
      .where(and(eq(orbitEvals.agentId, agentId), isNotNull(orbitEvals.version)));
    return new Map(
      rows.flatMap((r) =>
        r.version !== null && r.attackSuccessRate !== null
          ? [[r.version, { ...r, attackSuccessRate: r.attackSuccessRate }] as const]
          : [],
      ),
    );
  });
}

/** Unfinished evals created before `before`: their driver died or the Job never reported. */
export function staleEvals(db: KobeDb, teamId: string, before: Date): Promise<EvalRecord[]> {
  return withTeam(db, teamId, (tx) =>
    tx
      .select(COLUMNS)
      .from(orbitEvals)
      .where(and(inArray(orbitEvals.status, ACTIVE), lt(orbitEvals.createdAt, before))),
  );
}
