import {
  MODELS_BUDGETS_PREFIX,
  eq,
  notifyModels,
  sql,
  teamSkillSettings,
  withTeam,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { TeamEvalCap } from "@kobe/protocol";
import { recordAudit } from "../audit/record.js";
import { isModelEnabled } from "../models/team-store.js";

/**
 * The team's skill switches (KOBE-80, D22; SK25): members' personal skills can be left out of the
 * team's runs, and the catalog switches "Members may add catalog skills for themselves" and
 * "Builders may install catalog skills" (both on by default). No row means the defaults.
 */

/** One writer of the team's skill switches at a time (the row may not exist yet). */
async function lockSettings(tx: KobeTx, teamId: string): Promise<void> {
  const key = `kobe.skills.settings:${teamId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export interface CatalogSwitches {
  readonly membersMayAdd: boolean;
  readonly buildersMayInstall: boolean;
}

export async function readCatalogSwitches(tx: KobeTx, teamId: string): Promise<CatalogSwitches> {
  const [row] = await tx
    .select({
      membersMayAdd: teamSkillSettings.membersMayAddCatalog,
      buildersMayInstall: teamSkillSettings.buildersMayInstallCatalog,
    })
    .from(teamSkillSettings)
    .where(eq(teamSkillSettings.teamId, teamId));
  return row ?? { membersMayAdd: true, buildersMayInstall: true };
}

/** "Builders may promote without confirmation" (KOBE-333, SK19): off unless a Team admin turns it on. */
export async function readBuildersMayPromote(tx: KobeTx, teamId: string): Promise<boolean> {
  const [row] = await tx
    .select({ on: teamSkillSettings.buildersMayPromote })
    .from(teamSkillSettings)
    .where(eq(teamSkillSettings.teamId, teamId));
  return row?.on ?? false;
}

export function getBuildersMayPromote(db: KobeDb, teamId: string): Promise<boolean> {
  return withTeam(db, teamId, (tx) => readBuildersMayPromote(tx, teamId));
}

async function writeBuildersMayPromote(
  tx: KobeTx,
  teamId: string,
  userId: string,
  on: boolean,
): Promise<void> {
  if ((await readBuildersMayPromote(tx, teamId)) === on) return;
  await tx
    .insert(teamSkillSettings)
    .values({ teamId, buildersMayPromote: on, updatedBy: userId })
    .onConflictDoUpdate({
      target: teamSkillSettings.teamId,
      set: { buildersMayPromote: on, updatedBy: userId, updatedAt: new Date() },
    });
  await recordAudit(tx, {
    action: "skill.catalog_switches.changed",
    teamId,
    target: { buildersMayPromote: on },
  });
}

export async function readPersonalSkillsDisabled(tx: KobeTx, teamId: string): Promise<boolean> {
  const [row] = await tx
    .select({ disabled: teamSkillSettings.personalSkillsDisabled })
    .from(teamSkillSettings)
    .where(eq(teamSkillSettings.teamId, teamId));
  return row?.disabled ?? false;
}

export function getPersonalSkillsDisabled(db: KobeDb, teamId: string): Promise<boolean> {
  return withTeam(db, teamId, (tx) => readPersonalSkillsDisabled(tx, teamId));
}

/** Sets the switch and audits a real change; returns the value in force. */
export function setPersonalSkillsDisabled(
  db: KobeDb,
  teamId: string,
  userId: string,
  disabled: boolean,
): Promise<boolean> {
  return withTeam(db, teamId, (tx) => writePersonalSkillsDisabled(tx, teamId, userId, disabled));
}

async function writePersonalSkillsDisabled(
  tx: KobeTx,
  teamId: string,
  userId: string,
  disabled: boolean,
): Promise<boolean> {
  await lockSettings(tx, teamId);
  if ((await readPersonalSkillsDisabled(tx, teamId)) === disabled) return disabled;
  await tx
    .insert(teamSkillSettings)
    .values({ teamId, personalSkillsDisabled: disabled, updatedBy: userId })
    .onConflictDoUpdate({
      target: teamSkillSettings.teamId,
      set: { personalSkillsDisabled: disabled, updatedBy: userId, updatedAt: new Date() },
    });
  await recordAudit(tx, {
    action: "skill.personal_switch.changed",
    teamId,
    target: { disabled },
  });
  return disabled;
}

export function getCatalogSwitches(db: KobeDb, teamId: string): Promise<CatalogSwitches> {
  return withTeam(db, teamId, (tx) => readCatalogSwitches(tx, teamId));
}

/**
 * Changes the catalog switches given (a Team admin's act, SK25) and audits the ones that changed;
 * returns the values in force. A team with no settings row gets one (the personal switch stays
 * at its default, off).
 */
export function setCatalogSwitches(
  db: KobeDb,
  teamId: string,
  userId: string,
  change: Partial<CatalogSwitches>,
): Promise<CatalogSwitches> {
  return withTeam(db, teamId, (tx) => writeCatalogSwitches(tx, teamId, userId, change));
}

async function writeCatalogSwitches(
  tx: KobeTx,
  teamId: string,
  userId: string,
  change: Partial<CatalogSwitches>,
): Promise<CatalogSwitches> {
  // Two admins changing different switches at once: the second reads the first's commit, and
  // only changed columns are written (review S2 of KOBE-316).
  await lockSettings(tx, teamId);
  const before = await readCatalogSwitches(tx, teamId);
  const after = { ...before, ...change };
  const changed = {
    ...(after.membersMayAdd !== before.membersMayAdd
      ? { membersMayAddCatalog: after.membersMayAdd }
      : {}),
    ...(after.buildersMayInstall !== before.buildersMayInstall
      ? { buildersMayInstallCatalog: after.buildersMayInstall }
      : {}),
  };
  if (Object.keys(changed).length === 0) return before;
  const set = { ...changed, updatedBy: userId };
  await tx
    .insert(teamSkillSettings)
    .values({ teamId, ...set })
    .onConflictDoUpdate({
      target: teamSkillSettings.teamId,
      set: { ...set, updatedAt: new Date() },
    });
  await recordAudit(tx, { action: "skill.catalog_switches.changed", teamId, target: changed });
  return after;
}

/**
 * The team's eval judge (KOBE-326, SK17): the alias a Team admin chose, if the team still enables
 * it; null otherwise (the team default judges then). Used when the Site's judge is not enabled in
 * the team.
 */
export async function readEvalJudgeAlias(tx: KobeTx, teamId: string): Promise<string | null> {
  const [row] = await tx
    .select({ alias: teamSkillSettings.evalJudgeAlias })
    .from(teamSkillSettings)
    .where(eq(teamSkillSettings.teamId, teamId));
  const alias = row?.alias ?? null;
  return alias !== null && (await isModelEnabled(tx, teamId, alias)) ? alias : null;
}

export function getEvalJudgeAlias(db: KobeDb, teamId: string): Promise<string | null> {
  return withTeam(db, teamId, (tx) => readEvalJudgeAlias(tx, teamId));
}

/**
 * Sets the team's eval judge (a Team admin's act) to one of the team's enabled models, or clears
 * it (null: the team default). Refuses a model the team has not enabled; audits a real change.
 */
export function setEvalJudgeAlias(
  db: KobeDb,
  teamId: string,
  userId: string,
  alias: string | null,
): Promise<{ ok: true; alias: string | null } | { ok: false }> {
  return withTeam(db, teamId, (tx) => writeEvalJudgeAlias(tx, teamId, userId, alias));
}

async function writeEvalJudgeAlias(
  tx: KobeTx,
  teamId: string,
  userId: string,
  alias: string | null,
): Promise<{ ok: true; alias: string | null } | { ok: false }> {
  await lockSettings(tx, teamId);
  if (alias !== null && !(await isModelEnabled(tx, teamId, alias))) return { ok: false };
  const [row] = await tx
    .select({ alias: teamSkillSettings.evalJudgeAlias })
    .from(teamSkillSettings)
    .where(eq(teamSkillSettings.teamId, teamId));
  if ((row?.alias ?? null) === alias) return { ok: true, alias };
  await tx
    .insert(teamSkillSettings)
    .values({ teamId, evalJudgeAlias: alias, updatedBy: userId })
    .onConflictDoUpdate({
      target: teamSkillSettings.teamId,
      set: { evalJudgeAlias: alias, updatedBy: userId, updatedAt: new Date() },
    });
  await recordAudit(tx, { action: "skill.eval_judge.changed", teamId, target: { alias } });
  return { ok: true, alias };
}

/**
 * The team eval cap (KOBE-327, SK18): monthly dollars or tokens, or null (none, the default).
 * Enforced per eval call through `kobe_reserve_budget`; new evals are refused once it is used up.
 */
export async function readEvalCap(tx: KobeTx, teamId: string): Promise<TeamEvalCap> {
  const [row] = await tx
    .select({ usd: teamSkillSettings.evalCapUsd, tokens: teamSkillSettings.evalCapTokens })
    .from(teamSkillSettings)
    .where(eq(teamSkillSettings.teamId, teamId));
  if (row?.usd !== null && row?.usd !== undefined) return { usd: Number(row.usd) };
  if (row?.tokens !== null && row?.tokens !== undefined) return { tokens: Number(row.tokens) };
  return null;
}

export function getEvalCap(db: KobeDb, teamId: string): Promise<TeamEvalCap> {
  return withTeam(db, teamId, (tx) => readEvalCap(tx, teamId));
}

const sameCap = (a: TeamEvalCap, b: TeamEvalCap) => JSON.stringify(a) === JSON.stringify(b);

export async function writeEvalCap(
  tx: KobeTx,
  teamId: string,
  userId: string,
  cap: TeamEvalCap,
): Promise<void> {
  await lockSettings(tx, teamId);
  if (sameCap(await readEvalCap(tx, teamId), cap)) return;
  const set = {
    evalCapUsd: cap && "usd" in cap ? cap.usd : null,
    evalCapTokens: cap && "tokens" in cap ? cap.tokens : null,
    updatedBy: userId,
  };
  await tx
    .insert(teamSkillSettings)
    .values({ teamId, ...set })
    .onConflictDoUpdate({
      target: teamSkillSettings.teamId,
      set: { ...set, updatedAt: new Date() },
    });
  await recordAudit(tx, { action: "skill.eval_cap.changed", teamId, target: { cap } });
  // The gateways judge eval calls by the cap: drop their cached budget state for the team.
  await notifyModels(tx, `${MODELS_BUDGETS_PREFIX}${teamId}`);
}

export interface TeamSkillSettingsChange {
  readonly personalSkillsDisabled?: boolean;
  readonly catalog?: Partial<CatalogSwitches>;
  readonly evalJudgeAlias?: string | null;
  readonly buildersMayPromote?: boolean;
}

/**
 * One settings request in one transaction (KOBE-326 review L6): all of it or nothing. The judge
 * goes first; a model the team hasn't enabled refuses the request before anything is written.
 */
export function setTeamSkillSettings(
  db: KobeDb,
  teamId: string,
  userId: string,
  change: TeamSkillSettingsChange,
): Promise<{ ok: true } | { ok: false; code: "model_not_enabled" }> {
  return withTeam(db, teamId, async (tx) => {
    await lockSettings(tx, teamId);
    if (change.evalJudgeAlias !== undefined) {
      const set = await writeEvalJudgeAlias(tx, teamId, userId, change.evalJudgeAlias);
      if (!set.ok) return { ok: false, code: "model_not_enabled" } as const;
    }
    if (change.personalSkillsDisabled !== undefined)
      await writePersonalSkillsDisabled(tx, teamId, userId, change.personalSkillsDisabled);
    if (change.catalog && Object.keys(change.catalog).length > 0)
      await writeCatalogSwitches(tx, teamId, userId, change.catalog);
    if (change.buildersMayPromote !== undefined)
      await writeBuildersMayPromote(tx, teamId, userId, change.buildersMayPromote);
    return { ok: true } as const;
  });
}

/** Sets or removes the team eval cap in its own transaction (`PUT /v1/team/budgets/eval-cap`). */
export function setEvalCap(
  db: KobeDb,
  teamId: string,
  userId: string,
  cap: TeamEvalCap,
): Promise<void> {
  return withTeam(db, teamId, (tx) => writeEvalCap(tx, teamId, userId, cap));
}
