import { canonicalZip, PROVENANCE_API_VERSION } from "@kobe/protocol";
import type { ScanResult } from "@kobe/skill-scanner";
import { sql, type KobeDb, type KobeTx } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import type { BlobStore } from "../../retention/blobs.js";
import { validateZipBundle, type ValidBundle } from "../bundle.js";
import { queueDefaultSync } from "../default-sync.js";
import { defaultTargets, lockDefaultSet, majorOf } from "../default-target.js";
import { DRAFT_LIMITS, SKILL_MD_PATH } from "../drafts/files.js";
import { withSavedNumber } from "../drafts/manifest-sync.js";
import { ensureObject, scanDocument } from "../kobe-seed.js";
import { SKILL_LIMITS } from "../limits.js";
import { scanCanonicalZip } from "../review.js";
import { SCAN_RETRY_AFTER_SECONDS, ScanBusyError } from "../scan-pool.js";
import { compareSemver } from "../semver.js";
import { sha256Hex } from "../storage.js";
import { newestSemver, versionRows } from "./catalog-view.js";
import { detachInTx } from "./kobe-detach.js";
import {
  allDraftFiles,
  asSiteAdmin,
  draftOf,
  lockedSkill,
  refuse,
  refuseBlocklisted,
  type SiteDraftFailure,
} from "./site-drafts.js";

/**
 * Save version of a site draft (KOBE-495; Chris's decision of 2026-10-23): the draft's files are
 * validated as an upload is, scanned in the shared pool (a Block stops it, with the findings),
 * numbered with the semver the admin confirmed (it must be above every version of the skill), and
 * published straight into the Catalog as an immutable version with publisher `site`: the admin
 * is its submitter, nobody reviews it (the database's `registry_versions_site_publisher`). Its
 * bytes go to the catalog's content-addressed store first, as every version's; one transaction
 * then re-checks the admin, the skill (retired, blocklisted) and the number under the skill's lock,
 * writes the version with its provenance (the previous publisher and version), detaches a Kobe
 * skill, queues a Default `add` when the version is in the Default's major (pinned installs never
 * move; Track installs take it at the next run), audits `registry.version_published` and drops
 * the draft. The maintainers of a team-published skill are told afterwards (`site-notify.ts`).
 */

export interface PublishRequest {
  readonly semver: string;
  readonly changelog: string;
  /** The revision the admin saw (`If-Match`). */
  readonly rev: number;
}

export interface Published {
  readonly versionId: string;
  readonly skillId: string;
  readonly name: string;
  readonly semver: string;
  readonly verdict: "pass" | "caution";
  readonly previous: { readonly publisher: string; readonly semver: string } | null;
  /** The team whose maintainers are told (a team-published skill), or null. */
  readonly notifyTeamId: string | null;
}

export type PublishFailure =
  | SiteDraftFailure
  | {
      readonly error:
        | "skill_md_missing"
        | "invalid_package"
        | "name_changed"
        | "semver_not_increasing"
        | "scan_busy";
      readonly message: string;
      readonly retryAfter?: number;
    }
  | { readonly error: "scan_block"; readonly message: string; readonly scan: ScanResult };

export type PublishResult =
  { readonly ok: true; readonly published: Published } | ({ readonly ok: false } & PublishFailure);

/** The zip of a draft is stored, not deflated: the 5 MiB of files plus headers. */
const DRAFT_BUNDLE_LIMITS = {
  ...SKILL_LIMITS,
  maxBundleBytes: DRAFT_LIMITS.maxDraftBytes + DRAFT_LIMITS.maxFiles * 1024,
};

const fail = (f: PublishFailure): PublishResult => ({ ok: false, ...f });

/** Validates and numbers the draft's files; the bundle, or why not. */
export function packageOf(
  files: ReadonlyMap<string, Uint8Array>,
  name: string,
  request: Pick<PublishRequest, "semver" | "changelog">,
): { ok: true; bundle: ValidBundle } | { ok: false; failure: PublishFailure } {
  if (!files.has(SKILL_MD_PATH))
    return {
      ok: false,
      failure: { error: "skill_md_missing", message: "The draft needs a SKILL.md at its root." },
    };
  const packaged = withSavedNumber(files, request.semver, request.changelog);
  const valid = validateZipBundle(canonicalZip(packaged), DRAFT_BUNDLE_LIMITS);
  if (!valid.ok)
    return { ok: false, failure: { error: "invalid_package", message: valid.error.message } };
  if (valid.value.name !== name)
    return {
      ok: false,
      failure: {
        error: "name_changed",
        message: `SKILL.md must keep the catalog name ${name}: a new name is a new skill.`,
      },
    };
  return { ok: true, bundle: valid.value };
}

async function scanOf(bundle: ValidBundle, userId: string): Promise<ScanResult | PublishFailure> {
  try {
    return await scanCanonicalZip(bundle.packageZip ?? bundle.zip, { owner: userId });
  } catch (err) {
    if (!(err instanceof ScanBusyError)) throw err;
    return {
      error: "scan_busy",
      message: "Skill scanning is busy. Try again shortly.",
      retryAfter: SCAN_RETRY_AFTER_SECONDS,
    };
  }
}

const notIncreasing = (semver: string, newest: string): PublishFailure => ({
  error: "semver_not_increasing",
  message: `Version ${semver} must be higher than the skill's newest version, ${newest}.`,
});

interface Previous {
  readonly id: string;
  readonly semver: string;
  readonly publisher: string;
}

function provenance(
  name: string,
  semver: string,
  bundle: ValidBundle,
  scan: ScanResult,
  who: { readonly userId: string; readonly at: Date },
  previous: Previous | null,
  baseVersionId: string,
) {
  return {
    apiVersion: PROVENANCE_API_VERSION,
    publisher: "site",
    name,
    version: semver,
    hashes: { runtime: sha256Hex(bundle.zip), package: bundle.packageHash },
    publishedBy: { userId: who.userId, at: who.at.toISOString() },
    basedOn: { versionId: baseVersionId },
    previous: previous
      ? { versionId: previous.id, publisher: previous.publisher, semver: previous.semver }
      : null,
    scan: {
      scanner: {
        name: "kobe-skill-scanner",
        version: scan.ruleSetVersion,
        rulesVersion: scan.ruleSetVersion,
      },
      verdict: scan.verdict,
      findings: scan.findings.map(({ category, rule, file, line }) => ({
        category,
        rule,
        file,
        line,
      })),
    },
    createdAt: who.at.toISOString(),
  };
}

/** The team of the skill's newest published maintainer version (the publishing team), if any. */
async function publishingTeam(tx: KobeTx, skillId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ team_id: string | null }>(sql`
    SELECT source ->> 'teamId' AS team_id FROM registry_versions
     WHERE skill_id = ${skillId} AND publisher = 'maintainer'
       AND state IN ('approved', 'deprecated', 'withdrawn', 'revoked')
     ORDER BY seq DESC LIMIT 1`);
  const id = rows[0]?.team_id ?? null;
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** A Default `add` when the version is in the major Default installs follow (fills teams). */
/** The admin asked for it (as a tag change does): installs name them, never Kobe. */
async function applyDefault(
  tx: KobeTx,
  skillId: string,
  version: { readonly id: string; readonly semver: string },
  userId: string,
) {
  const [current] = await defaultTargets(tx, skillId);
  const target = { id: version.id, semver: version.semver, major: majorOf(version.semver) };
  if (current?.major === target.major)
    await queueDefaultSync(tx, { skillId, kind: "add", target, requestedBy: userId });
}

/** Published states: the version teams could have had (a submission in review is not one). */
export const PUBLISHED_STATES: readonly string[] = [
  "approved",
  "deprecated",
  "withdrawn",
  "revoked",
  "suspended",
];

export async function publishSiteDraft(
  deps: { readonly db: KobeDb; readonly blobs: BlobStore },
  userId: string,
  skillId: string,
  request: PublishRequest,
): Promise<PublishResult> {
  const draft = await draftOf(deps.db, skillId);
  if (!draft) return fail({ error: "not_found" });
  if (draft.rev !== request.rev)
    return fail({ error: "stale_revision", rev: draft.rev, changedBy: draft.updatedBy });
  const skillName = await deps.db.execute<{ name: string }>(sql`
    SELECT name FROM registry_skills WHERE id = ${skillId}`);
  const name = skillName.rows[0]?.name;
  if (!name) return fail({ error: "not_found" });
  const newest = newestSemver(await versionRows(deps.db, skillId));
  if (newest !== null && compareSemver(request.semver, newest) <= 0)
    return fail(notIncreasing(request.semver, newest));
  const pkg = packageOf(await allDraftFiles(deps.db, draft.id), name, request);
  if (!pkg.ok) return fail(pkg.failure);
  const { bundle } = pkg;
  const scan = await scanOf(bundle, userId);
  if ("error" in scan) return fail(scan);
  if (scan.verdict === "block")
    return fail({
      error: "scan_block",
      message: "The scan blocks this version: fix the findings and save again.",
      scan,
    });
  // Bytes before records, as every catalog version (content-addressed: shared, never overwritten).
  const runtimeHash = sha256Hex(bundle.zip);
  const runtimeKey = await ensureObject(deps.blobs, bundle.zip, runtimeHash);
  const packageKey = bundle.packageZip
    ? await ensureObject(deps.blobs, bundle.packageZip, bundle.packageHash)
    : null;
  const verdict = scan.verdict;
  const result = await asSiteAdmin(deps.db, userId, async (tx) => {
    // The Default-set lock before the skill's row, the order the seed and the tag changes keep.
    await lockDefaultSet(tx, "exclusive");
    await lockedSkill(tx, skillId);
    const locked = await draftOf(tx, skillId, true);
    if (!locked) return refuse({ error: "not_found" });
    if (locked.rev !== request.rev)
      return refuse({ error: "stale_revision", rev: locked.rev, changedBy: locked.updatedBy });
    const versions = await versionRows(tx, skillId);
    await refuseBlocklisted(tx, [
      runtimeHash,
      bundle.packageHash,
      ...versions.flatMap((v) => [v.runtimeHash, v.packageHash]),
    ]);
    const top = newestSemver(versions);
    if (top !== null && compareSemver(request.semver, top) <= 0)
      throw new Raced(notIncreasing(request.semver, top));
    // The version this one follows: the newest published one, not a submission in review.
    const last = versions.find((v) => PUBLISHED_STATES.includes(v.state));
    const previous: Previous | null = last
      ? { id: last.id, semver: last.semver, publisher: last.publisher }
      : null;
    const now = new Date();
    const prov = provenance(
      name,
      request.semver,
      bundle,
      scan,
      { userId, at: now },
      previous,
      locked.baseVersionId,
    );
    const seq = versions.reduce((n, v) => Math.max(n, v.seq), 0) + 1;
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO registry_versions (skill_id, publisher, semver, seq, runtime_hash, package_hash,
        runtime_storage_key, runtime_size_bytes, package_storage_key, manifest, provenance, source,
        scan, verdict, state, submitted_by, submitted_at, approved_at)
      VALUES (${skillId}, 'site', ${request.semver}, ${seq}, ${runtimeHash}, ${bundle.packageHash},
        ${runtimeKey}, ${bundle.zip.length}, ${packageKey},
        ${JSON.stringify(bundle.manifest ?? {})}::jsonb, ${JSON.stringify(prov)}::jsonb,
        ${JSON.stringify({ publisher: "site", publishedBy: userId })}::jsonb,
        ${JSON.stringify(scanDocument(scan))}::jsonb, ${verdict}::scan_verdict, 'approved',
        ${userId}, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
      RETURNING id`);
    const versionId = inserted.rows[0]?.id;
    if (!versionId) throw new Error("site version insert returned no row");
    // The mark goes with the publish, never after it (KOBE-494 review).
    await detachInTx(tx, skillId, userId);
    const summary = (bundle.manifest?.summary ?? "").slice(0, 280);
    if (summary)
      await tx.execute(sql`
        UPDATE registry_skills SET summary = ${summary}, updated_at = now()
         WHERE id = ${skillId} AND summary IS DISTINCT FROM ${summary}`);
    await applyDefault(tx, skillId, { id: versionId, semver: request.semver }, userId);
    await recordAudit(tx, {
      action: "registry.version_published",
      target: {
        registryVersionId: versionId,
        skillId,
        name,
        semver: request.semver,
        publisher: "site",
        publishedBy: userId,
        verdict: verdict === "caution" ? "caution" : "pass",
        runtimeHash,
        previousPublisher: (previous?.publisher ?? null) as "kobe" | "maintainer" | "site" | null,
        previousSemver: previous?.semver ?? null,
      },
    });
    await tx.execute(sql`DELETE FROM site_skill_drafts WHERE id = ${locked.id}`);
    const published: Published = {
      versionId,
      skillId,
      name,
      semver: request.semver,
      verdict: verdict === "caution" ? "caution" : "pass",
      previous: previous ? { publisher: previous.publisher, semver: previous.semver } : null,
      notifyTeamId: await publishingTeam(tx, skillId),
    };
    return { published };
  }).catch((err: unknown) => {
    if (err instanceof Raced) return { ok: false as const, ...err.failure };
    throw err;
  });
  if (!result.ok) return result as PublishResult;
  return { ok: true, published: result.published };
}

/** Another version took the number while this one scanned. */
class Raced extends Error {
  constructor(readonly failure: PublishFailure) {
    super(failure.error);
  }
}
