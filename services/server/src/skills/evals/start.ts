import { randomUUID } from "node:crypto";
import {
  and,
  eq,
  personalSkillVersions,
  personalSkills,
  siteSkillSettings,
  teamSkillVersions,
  sql,
  withTeam,
  type KobeDb,
  type KobeTx,
  type TeamRole,
} from "@kobe/db";
import {
  canonicalZip,
  EVAL_CASES_PATH,
  planSkillEvalExecutions,
  SkillPackageError,
  type SkillEvalEstimate,
  type SkillEvalJudgeModel,
  type SkillEvalMode,
  type SkillEvalRunModel,
  type SkillEvalStarted,
  type SkillEvalSubject,
} from "@kobe/protocol";
import { parseSkillEvalSuite, type SkillEvalIssue } from "@kobe/protocol/skill-evals";
import type { ScanResult } from "@kobe/skill-scanner";
import { unzipSync } from "fflate";
import { teamRoleAllows } from "../../authz/permissions.js";
import { isModelEnabled } from "../../models/team-store.js";
import type { BlobStore } from "../../retention/blobs.js";
import { resolveRunModel } from "../../runs/models.js";
import { readVerified } from "../blob-read.js";
import { isBlocked } from "../blocklist.js";
import { validateZipBundle } from "../bundle.js";
import { readAllFiles, visibleDraft } from "../drafts/records.js";
import { testGate } from "../drafts/test-gates.js";
import { readEvalJudgeAlias } from "../settings.js";
import { readPackage } from "../registry/review-diff.js";
import { versionRow as registryVersionRow } from "../registry/review-queue.js";
import { scanCanonicalZip } from "../review.js";
import { ScanBusyError } from "../scan-pool.js";
import { siteEvalLimits } from "./runner.js";
import {
  evalBundleKey,
  evalFixturesKey,
  evalTree,
  fixturesZip,
  putEvalObject,
  sha256Hex,
} from "./storage.js";
import { evalBudgetBlock, evalBudgetBlockIn } from "./budget.js";
import { estimateSkillEvalIn } from "./estimate.js";
import { insertEvalRun } from "./store.js";

// Starting a skill eval (KOBE-325, SK16; routes in routes/skill-evals.ts): the subject's package
// (a draft's current revision, or a saved team or personal version), validated as an upload is,
// gated like a Workbench test chat, its suite parsed under the Site's case limit, the whole tree
// scanned, then the runtime zip and the cases' fixtures stored in the eval's own tree and one
// queued result per planned execution. Outside any run transaction: a scan takes seconds.

export type StartRefusal = {
  readonly status: 403 | 404 | 409 | 422 | 503;
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly SkillEvalIssue[];
};

/**
 * What to evaluate: a draft's current revision, a saved version (by its seq), or a Registry
 * version (KOBE-335: the Registry team's re-run for its authoritative scorecard; its package is
 * read from the catalog store by the hashes its row records).
 */
export type StartSubject =
  | { readonly kind: "draft"; readonly draftId: string }
  | Extract<SkillEvalSubject, { kind: "version" }>
  | { readonly kind: "registry"; readonly versionId: string };

export interface EvalStarter {
  readonly teamId: string;
  readonly userId: string;
  readonly role: TeamRole;
}

interface LoadedPackage {
  readonly kind: "draft" | "team" | "personal" | "registry";
  readonly id: string;
  readonly rev: number;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

const refuse = (
  status: StartRefusal["status"],
  code: string,
  message: string,
): { ok: false; refusal: StartRefusal } => ({ ok: false, refusal: { status, code, message } });

async function loadPackage(
  db: KobeDb,
  blobs: BlobStore,
  who: EvalStarter,
  subject: StartSubject,
): Promise<LoadedPackage | null> {
  if (subject.kind === "draft") {
    return withTeam(db, who.teamId, async (tx) => {
      const draft = await visibleDraft(tx, who.teamId, subject.draftId, who);
      if (!draft) return null;
      const files = await readAllFiles(tx, who.teamId, subject.draftId);
      return { kind: "draft" as const, id: subject.draftId, rev: draft.rev, files };
    });
  }
  if (subject.kind === "registry") {
    const v = await registryVersionRow(db, subject.versionId);
    if (!v || v.publisher !== "maintainer") return null;
    const zip = await readPackage(blobs, v);
    if (!zip) return null;
    return {
      kind: "registry",
      id: v.id,
      rev: v.seq,
      files: new Map(Object.entries(unzipSync(zip))),
    };
  }
  const row = await withTeam(db, who.teamId, (tx) => versionRow(tx, who, subject));
  if (!row) return null;
  const zip = await readVerified(blobs, row.key, row.hash, row.size);
  if (!zip) return null;
  return {
    kind: subject.scope,
    id: subject.skillId,
    rev: subject.seq,
    files: new Map(Object.entries(unzipSync(zip))),
  };
}

/** A saved version's package zip (or its runtime zip when they are the same bytes). */
async function versionRow(
  tx: KobeTx,
  who: EvalStarter,
  subject: Extract<SkillEvalSubject, { kind: "version" }>,
): Promise<{ key: string; hash: string; size: number | null } | null> {
  if (subject.scope === "team") {
    const [v] = await tx
      .select({
        storageKey: teamSkillVersions.storageKey,
        contentHash: teamSkillVersions.contentHash,
        sizeBytes: teamSkillVersions.sizeBytes,
        packageKey: teamSkillVersions.packageStorageKey,
        packageHash: teamSkillVersions.packageHash,
      })
      .from(teamSkillVersions)
      .where(
        and(
          eq(teamSkillVersions.teamId, who.teamId),
          eq(teamSkillVersions.skillId, subject.skillId),
          eq(teamSkillVersions.seq, subject.seq),
        ),
      );
    if (!v) return null;
    return v.packageKey && v.packageHash
      ? { key: v.packageKey, hash: v.packageHash, size: null }
      : { key: v.storageKey, hash: v.contentHash, size: v.sizeBytes };
  }
  const [v] = await tx
    .select({
      storageKey: personalSkillVersions.storageKey,
      contentHash: personalSkillVersions.contentHash,
      sizeBytes: personalSkillVersions.sizeBytes,
      packageKey: personalSkillVersions.packageStorageKey,
      packageHash: personalSkillVersions.packageHash,
    })
    .from(personalSkillVersions)
    .innerJoin(personalSkills, eq(personalSkills.id, personalSkillVersions.skillId))
    .where(
      and(
        eq(personalSkillVersions.skillId, subject.skillId),
        eq(personalSkillVersions.seq, subject.seq),
        eq(personalSkills.ownerUserId, who.userId),
      ),
    );
  if (!v) return null;
  return v.packageKey && v.packageHash
    ? { key: v.packageKey, hash: v.packageHash, size: null }
    : { key: v.storageKey, hash: v.contentHash, size: v.sizeBytes };
}

const INCOMPLETE = new Set(["scan-incomplete", "scan-resources-exceeded"]);

async function scanPackage(
  zip: Uint8Array,
  owner: string,
): Promise<{ ok: true } | { ok: false; refusal: StartRefusal }> {
  let scan: ScanResult;
  try {
    scan = await scanCanonicalZip(zip, { owner });
  } catch (err) {
    if (!(err instanceof ScanBusyError)) throw err;
    return refuse(503, "scan_busy", "Skill scans are busy right now. Try again in a few seconds.");
  }
  if (scan.findings.some((f) => INCOMPLETE.has(f.rule)))
    return refuse(503, "scan_incomplete", "The skill's scan couldn't finish. Try again.");
  if (scan.verdict === "block")
    return refuse(409, "scan_blocked", "The scan blocks this skill, so it can't be evaluated.");
  return { ok: true };
}

/** The suite's model if the team enabled it, else the team's default (SK17: never silent). */
async function runModelFor(
  tx: KobeTx,
  teamId: string,
  requested: string | undefined,
): Promise<SkillEvalRunModel | null> {
  if (requested !== undefined && (await isModelEnabled(tx, teamId, requested)))
    return { requested, used: requested, fellBack: false };
  const fallback = await resolveRunModel(tx, teamId, undefined);
  const used = fallback.ok ? fallback.model?.alias : undefined;
  if (used === undefined) return null;
  return { requested: requested ?? null, used, fellBack: requested !== undefined };
}

/**
 * The judge (SK17, KOBE-326): the Site's `judge_alias` when the team enabled it; else the team's
 * own choice (a Team admin setting, while still enabled); else the team default; else the run's
 * model. Every candidate is an enabled model of the team: eval content never goes elsewhere (the
 * judge checks again when it calls).
 */
export async function judgeModelFor(
  tx: KobeTx,
  teamId: string,
  runModel: SkillEvalRunModel,
): Promise<SkillEvalJudgeModel> {
  const [site] = await tx.select({ alias: siteSkillSettings.judgeAlias }).from(siteSkillSettings);
  if (site?.alias && (await isModelEnabled(tx, teamId, site.alias)))
    return { alias: site.alias, source: "site" };
  const chosen = await readEvalJudgeAlias(tx, teamId);
  if (chosen !== null) return { alias: chosen, source: "team" };
  const fallback = await resolveRunModel(tx, teamId, undefined);
  return { alias: (fallback.ok && fallback.model?.alias) || runModel.used, source: "team" };
}

/** The Site's judge when set and enabled in the team; null otherwise (a Registry re-run's only judge). */
export async function siteJudgeFor(
  tx: KobeTx,
  teamId: string,
): Promise<SkillEvalJudgeModel | null> {
  const [site] = await tx.select({ alias: siteSkillSettings.judgeAlias }).from(siteSkillSettings);
  if (site?.alias && (await isModelEnabled(tx, teamId, site.alias)))
    return { alias: site.alias, source: "site" };
  return null;
}

const DUPLICATE =
  "You already have an eval of this revision in this mode queued or running. Wait for it or cancel it.";

/** Whether the starter already has an open eval of the same subject revision and mode. */
async function sameEvalOpen(
  tx: KobeTx,
  who: EvalStarter,
  subject: { readonly kind: string; readonly id: string; readonly rev: number },
  mode: SkillEvalMode,
): Promise<boolean> {
  const res = await tx.execute(sql`
    SELECT 1 FROM skill_eval_runs
     WHERE team_id = ${who.teamId} AND started_by = ${who.userId}
       AND subject_kind = ${subject.kind} AND subject_id = ${subject.id}
       AND subject_rev = ${subject.rev} AND mode = ${mode}
       AND status IN ('queued', 'running') AND cancel_requested_at IS NULL
     LIMIT 1`);
  return res.rows.length > 0;
}

/** Open evals at once: per starter and per team (review M4). */
export const MAX_OPEN_EVALS_PER_MEMBER = 3;
export const MAX_OPEN_EVALS_PER_TEAM = 20;

/** The team's skill eval lock (the runner's claims take the same one). */
export async function lockTeamEvals(tx: KobeTx, teamId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kobe.skill-eval:${teamId}`}, 0))`,
  );
}

async function openEvalsRefusal(tx: KobeTx, who: EvalStarter): Promise<string | null> {
  const res = await tx.execute<{ mine: number | string; team: number | string }>(sql`
    SELECT count(*) FILTER (WHERE started_by = ${who.userId}) AS mine, count(*) AS team
      FROM skill_eval_runs WHERE team_id = ${who.teamId} AND status IN ('queued', 'running')`);
  const row = res.rows[0];
  if (Number(row?.mine ?? 0) >= MAX_OPEN_EVALS_PER_MEMBER)
    return `You already have ${MAX_OPEN_EVALS_PER_MEMBER} evals running or queued. Wait for one to finish or cancel one.`;
  if (Number(row?.team ?? 0) >= MAX_OPEN_EVALS_PER_TEAM)
    return `Your team already has ${MAX_OPEN_EVALS_PER_TEAM} evals running or queued. Try again later.`;
  return null;
}

/** The subject's package, validated and gated, with its suite parsed (no scan yet). */
async function prepareSubject(
  deps: { readonly db: KobeDb; readonly blobs: BlobStore },
  who: EvalStarter,
  subject: StartSubject,
) {
  const pkg = await loadPackage(deps.db, deps.blobs, who, subject);
  if (!pkg) return refuse(404, "skill_not_found", "No such skill version or draft revision.");
  let zip: Uint8Array;
  try {
    zip = canonicalZip(pkg.files);
  } catch (err) {
    if (!(err instanceof SkillPackageError)) throw err;
    return refuse(422, "invalid_package", err.message);
  }
  const valid = validateZipBundle(zip);
  if (!valid.ok) return refuse(422, "invalid_package", valid.error.message);
  const runtime = valid.value.zip;
  const runtimeHash = sha256Hex(runtime);
  const casesBytes = pkg.files.get(EVAL_CASES_PATH);
  if (!casesBytes) return refuse(422, "no_suite", `The skill has no ${EVAL_CASES_PATH}.`);
  const limits = await siteEvalLimits(deps.db);
  const parsed = parseSkillEvalSuite(new TextDecoder().decode(casesBytes), {
    paths: pkg.files.keys(),
    maxCases: limits.maxCases,
  });
  if (!parsed.ok)
    return {
      ok: false as const,
      refusal: {
        status: 422 as const,
        code: "invalid_suite",
        message: `${EVAL_CASES_PATH} has problems.`,
        issues: parsed.issues,
      },
    };
  const suite = parsed.suite;
  const gate = await withTeam(deps.db, who.teamId, async (tx) => {
    if (await isBlocked(tx, runtimeHash)) return "blocklisted" as const;
    // A team version passed the team's review; a Registry version is the Registry team's own
    // review (KOBE-335). Drafts and personal versions are gated like a test chat.
    if (pkg.kind !== "team" && pkg.kind !== "registry") return testGate(tx, who, runtimeHash);
    return null;
  });
  if (gate === "blocklisted")
    return refuse(409, "skill_blocklisted", "This skill is on the site's blocklist.");
  if (gate) return refuse(403, gate, "This team's settings don't allow evaluating this skill.");
  return { ok: true as const, pkg, valid: valid.value, runtime, runtimeHash, suite, limits };
}

/** A budget or the team eval cap that stops new evals, as a refusal (KOBE-327, D30, SK18). */
async function budgetRefusal(db: KobeDb, who: EvalStarter) {
  const block = await evalBudgetBlock(db, who.teamId, who.userId);
  return block ? refuse(409, block.code, block.message) : null;
}

/**
 * "≈ $X, ≈ N min" before Run (KOBE-327, SK18): the same subject, gates and suite as a start,
 * the plan of `mode`, on the run model a start would use; no scan, nothing stored. Also says
 * whether a budget or the team eval cap would refuse the start (`blocked`).
 */
export async function estimateSkillEval(
  deps: { readonly db: KobeDb; readonly blobs: BlobStore },
  who: EvalStarter,
  subject: StartSubject,
  mode: SkillEvalMode,
): Promise<
  | {
      ok: true;
      value: {
        estimate: SkillEvalEstimate;
        runModel: SkillEvalRunModel;
        blocked: { code: string; message: string } | null;
      };
    }
  | { ok: false; refusal: StartRefusal }
> {
  const prepared = await prepareSubject(deps, who, subject);
  if (!prepared.ok) return prepared;
  const plan = planSkillEvalExecutions(prepared.suite, mode);
  const result = await withTeam(deps.db, who.teamId, async (tx) => {
    const run = await runModelFor(tx, who.teamId, prepared.suite.model);
    if (!run) return null;
    const estimate = await estimateSkillEvalIn(tx, {
      teamId: who.teamId,
      userId: who.userId,
      teamWide: teamRoleAllows(who.role, "team.budgets.manage"),
      runModel: run.used,
      suite: prepared.suite,
      plan,
      concurrency: prepared.limits.maxConcurrentSandboxes,
      fixtureBytes: (f) => prepared.pkg.files.get(`evals/${f}`)?.length ?? 0,
    });
    return { run, estimate, blocked: await evalBudgetBlockIn(tx, who.teamId, who.userId) };
  });
  if (!result) return refuse(409, "no_model", "The team has no model enabled for evals.");
  return {
    ok: true,
    value: { estimate: result.estimate, runModel: result.run, blocked: result.blocked },
  };
}

export async function startSkillEval(
  deps: { readonly db: KobeDb; readonly blobs: BlobStore },
  who: EvalStarter,
  subject: StartSubject,
  mode: SkillEvalMode,
): Promise<{ ok: true; value: SkillEvalStarted } | { ok: false; refusal: StartRefusal }> {
  // Bounded queues (review M4): refused before the scan, checked again under the team's lock.
  const full = await withTeam(deps.db, who.teamId, (tx) => openEvalsRefusal(tx, who));
  if (full) return refuse(409, "too_many_evals", full);
  // A budget or the team eval cap that is used up refuses the start, saying which (KOBE-327).
  const blocked = await budgetRefusal(deps.db, who);
  if (blocked) return blocked;
  const prepared = await prepareSubject(deps, who, subject);
  if (!prepared.ok) return prepared;
  const { pkg, valid, runtime, runtimeHash, suite, limits } = prepared;
  // A double start is refused before the scan; checked again under the team's lock below.
  const twice = await withTeam(deps.db, who.teamId, (tx) =>
    sameEvalOpen(tx, who, { kind: pkg.kind, id: pkg.id, rev: pkg.rev }, mode),
  );
  if (twice) return refuse(409, "eval_already_running", DUPLICATE);
  const scanned = await scanPackage(valid.packageZip ?? runtime, who.userId);
  if (!scanned.ok) return scanned;
  const plan = planSkillEvalExecutions(suite, mode);
  const models = await withTeam(deps.db, who.teamId, async (tx) => {
    const run = await runModelFor(tx, who.teamId, suite.model);
    if (!run) return null;
    const rubric = suite.cases.some((c) => c.expect.judge !== undefined);
    // From the team's history before this run is stored (it has none of its own yet).
    const estimate = await estimateSkillEvalIn(tx, {
      teamId: who.teamId,
      userId: who.userId,
      teamWide: teamRoleAllows(who.role, "team.budgets.manage"),
      runModel: run.used,
      suite,
      plan,
      concurrency: limits.maxConcurrentSandboxes,
      fixtureBytes: (f) => pkg.files.get(`evals/${f}`)?.length ?? 0,
    });
    if (!rubric) return { run, judge: null, estimate };
    // A Registry re-run is judged by the Site judge only (SK17, SK23), never a team's choice.
    const judge =
      pkg.kind === "registry"
        ? await siteJudgeFor(tx, who.teamId)
        : await judgeModelFor(tx, who.teamId, run);
    if (!judge) return "no_site_judge" as const;
    return { run, judge, estimate };
  });
  if (!models) return refuse(409, "no_model", "The team has no model enabled for evals.");
  if (models === "no_site_judge")
    return refuse(
      409,
      "site_judge_unavailable",
      "The suite has judged cases: set the Site judge and enable it in the Registry team first.",
    );
  const id = randomUUID();
  const tree = evalTree(deps.blobs.prefix, who.teamId, id);
  const bundleKey = evalBundleKey(tree, runtimeHash);
  await putEvalObject(deps.blobs, bundleKey, runtime);
  const fixtures = fixturesZip(pkg.files, suite);
  const fixturesKey = fixtures ? evalFixturesKey(tree, sha256Hex(fixtures)) : null;
  if (fixtures && fixturesKey) await putEvalObject(deps.blobs, fixturesKey, fixtures);
  const inserted = await withTeam(deps.db, who.teamId, async (tx) => {
    await lockTeamEvals(tx, who.teamId);
    // A second start of what is already running (a double click, two tabs): refused under the
    // team's lock, so two concurrent starts never both pass (KOBE-328 review L5).
    if (await sameEvalOpen(tx, who, { kind: pkg.kind, id: pkg.id, rev: pkg.rev }, mode))
      return DUPLICATE;
    const refusal = await openEvalsRefusal(tx, who);
    if (refusal) return refusal;
    await insertEvalRun(tx, {
      teamId: who.teamId,
      id,
      startedBy: who.userId,
      subject: { kind: pkg.kind, id: pkg.id, rev: pkg.rev },
      skillName: valid.name,
      packageHash: valid.packageHash,
      runtimeHash,
      bundleKey,
      bundleSize: runtime.length,
      fixturesKey,
      mode,
      suite,
      limits: { ...limits },
      runModel: models.run,
      judgeModel: models.judge,
      plan,
    });
    return null;
  }).catch(async (err: unknown) => {
    // Never leave objects no row names (no purge would find them).
    await deps.blobs.objects.delete(fixturesKey ? [bundleKey, fixturesKey] : [bundleKey]);
    throw err;
  });
  if (inserted) {
    await deps.blobs.objects.delete(fixturesKey ? [bundleKey, fixturesKey] : [bundleKey]);
    return inserted === DUPLICATE
      ? refuse(409, "eval_already_running", DUPLICATE)
      : refuse(409, "too_many_evals", inserted);
  }
  return {
    ok: true,
    value: { evalRunId: id, estimate: models.estimate },
  };
}
