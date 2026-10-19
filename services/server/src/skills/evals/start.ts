import { randomUUID } from "node:crypto";
import {
  and,
  eq,
  personalSkillVersions,
  personalSkills,
  siteSkillSettings,
  teamSkillVersions,
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
  type SkillEvalJudgeModel,
  type SkillEvalMode,
  type SkillEvalRunModel,
  type SkillEvalStarted,
  type SkillEvalSubject,
} from "@kobe/protocol";
import { parseSkillEvalSuite, type SkillEvalIssue } from "@kobe/protocol/skill-evals";
import type { ScanResult } from "@kobe/skill-scanner";
import { unzipSync } from "fflate";
import { isModelEnabled } from "../../models/team-store.js";
import type { BlobStore } from "../../retention/blobs.js";
import { resolveRunModel } from "../../runs/models.js";
import { readVerified } from "../blob-read.js";
import { isBlocked } from "../blocklist.js";
import { validateZipBundle } from "../bundle.js";
import { readAllFiles, visibleDraft } from "../drafts/records.js";
import { testGate } from "../drafts/test-gates.js";
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

/** What to evaluate: a draft's current revision, or a saved version (by its seq). */
export type StartSubject =
  | { readonly kind: "draft"; readonly draftId: string }
  | Extract<SkillEvalSubject, { kind: "version" }>;

export interface EvalStarter {
  readonly teamId: string;
  readonly userId: string;
  readonly role: TeamRole;
}

interface LoadedPackage {
  readonly kind: "draft" | "team" | "personal";
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

/** The judge (SK17): the Site's alias when the team enabled it, else the team's default. */
async function judgeModelFor(
  tx: KobeTx,
  teamId: string,
  runModel: SkillEvalRunModel,
): Promise<SkillEvalJudgeModel> {
  const [site] = await tx.select({ alias: siteSkillSettings.judgeAlias }).from(siteSkillSettings);
  if (site?.alias && (await isModelEnabled(tx, teamId, site.alias)))
    return { alias: site.alias, source: "site" };
  const fallback = await resolveRunModel(tx, teamId, undefined);
  return { alias: (fallback.ok && fallback.model?.alias) || runModel.used, source: "team" };
}

export async function startSkillEval(
  deps: { readonly db: KobeDb; readonly blobs: BlobStore },
  who: EvalStarter,
  subject: StartSubject,
  mode: SkillEvalMode,
): Promise<{ ok: true; value: SkillEvalStarted } | { ok: false; refusal: StartRefusal }> {
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
      ok: false,
      refusal: {
        status: 422,
        code: "invalid_suite",
        message: `${EVAL_CASES_PATH} has problems.`,
        issues: parsed.issues,
      },
    };
  const suite = parsed.suite;
  const gate = await withTeam(deps.db, who.teamId, async (tx) => {
    if (await isBlocked(tx, runtimeHash)) return "blocklisted" as const;
    if (pkg.kind !== "team") return testGate(tx, who, runtimeHash);
    return null;
  });
  if (gate === "blocklisted")
    return refuse(409, "skill_blocklisted", "This skill is on the site's blocklist.");
  if (gate) return refuse(403, gate, "This team's settings don't allow evaluating this skill.");
  const scanned = await scanPackage(valid.value.packageZip ?? runtime, who.userId);
  if (!scanned.ok) return scanned;
  const plan = planSkillEvalExecutions(suite, mode);
  const models = await withTeam(deps.db, who.teamId, async (tx) => {
    const run = await runModelFor(tx, who.teamId, suite.model);
    if (!run) return null;
    const rubric = suite.cases.some((c) => c.expect.judge !== undefined);
    return { run, judge: rubric ? await judgeModelFor(tx, who.teamId, run) : null };
  });
  if (!models) return refuse(409, "no_model", "The team has no model enabled for evals.");
  const id = randomUUID();
  const tree = evalTree(deps.blobs.prefix, who.teamId, id);
  const bundleKey = evalBundleKey(tree, runtimeHash);
  await putEvalObject(deps.blobs, bundleKey, runtime);
  const fixtures = fixturesZip(pkg.files, suite);
  const fixturesKey = fixtures ? evalFixturesKey(tree, sha256Hex(fixtures)) : null;
  if (fixtures && fixturesKey) await putEvalObject(deps.blobs, fixturesKey, fixtures);
  await withTeam(deps.db, who.teamId, (tx) =>
    insertEvalRun(tx, {
      teamId: who.teamId,
      id,
      startedBy: who.userId,
      subject: { kind: pkg.kind, id: pkg.id, rev: pkg.rev },
      skillName: valid.value.name,
      packageHash: valid.value.packageHash,
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
    }),
  );
  return {
    ok: true,
    value: {
      evalRunId: id,
      // KOBE-327 adds the estimate from the team's history.
      estimate: { executions: plan.length, costUsd: null, minutes: null, basis: "none" },
    },
  };
}
