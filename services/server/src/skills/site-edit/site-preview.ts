import { canonicalZip, checkPackagePaths } from "@kobe/protocol";
import type { KobeDb } from "@kobe/db";
import type { ScanResult } from "@kobe/skill-scanner";
import type { BlobStore } from "../../retention/blobs.js";
import { adviseBump, bumpSemver, type BumpKind } from "../drafts/bump.js";
import { SKILL_MD_PATH } from "../drafts/files.js";
import { ScanBusyError, ScanCancelledError, scanPool } from "../scan-pool.js";
import {
  newestSemver,
  packageFiles,
  storedOf,
  storedVersion,
  versionRows,
} from "./catalog-view.js";
import { allDraftFiles, draftOf } from "./site-drafts.js";

/**
 * The site draft's live scan preview and suggested bump (KOBE-495), as the Workbench's (KOBE-321):
 * the same pool, worker and rules as Save version (`preview: true`: never queued, gives its slot up
 * to real scans), one complete scan cached per (draft, revision); the bump against the skill's
 * newest version, by the Workbench's rules (patch, minor, major).
 */

export type SitePreview =
  | { readonly ok: true; readonly rev: number; readonly scan: ScanResult }
  | { readonly ok: false; readonly error: "not_found" | "busy" | "unavailable" }
  | { readonly ok: false; readonly error: "package_problem"; readonly message: string };

const CACHE_MAX = 32;
const cache = new Map<string, ScanResult>();
const INCOMPLETE = new Set(["scan-incomplete", "scan-resources-exceeded"]);

export async function previewSiteDraft(
  db: KobeDb,
  skillId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<SitePreview> {
  const draft = await draftOf(db, skillId);
  if (!draft) return { ok: false, error: "not_found" };
  const key = `${draft.id}/${draft.rev}`;
  const hit = cache.get(key);
  if (hit) return { ok: true, rev: draft.rev, scan: hit };
  const files = await allDraftFiles(db, draft.id);
  const problem = checkPackagePaths(files.keys()).find((p) => p.problem !== "skill_md_missing");
  if (problem)
    return {
      ok: false,
      error: "package_problem",
      message: `${problem.path || "A path"} can't be in a skill (${problem.problem.replaceAll("_", " ")}).`,
    };
  if (!files.has(SKILL_MD_PATH))
    return {
      ok: false,
      error: "package_problem",
      message: "The draft needs a SKILL.md at its root.",
    };
  try {
    const scan = await scanPool().scan(canonicalZip(files), {
      owner: userId,
      preview: true,
      ...(signal ? { signal } : {}),
    });
    if (scan.findings.some((f) => INCOMPLETE.has(f.rule)))
      return { ok: false, error: "unavailable" };
    cache.set(key, scan);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return { ok: true, rev: draft.rev, scan };
  } catch (err) {
    if (err instanceof ScanBusyError || err instanceof ScanCancelledError)
      return { ok: false, error: "busy" };
    throw err;
  }
}

export interface SiteBump {
  readonly rev: number;
  readonly latest: { readonly skillId: string; readonly semver: string } | null;
  readonly kind: BumpKind | null;
  readonly suggested: string | null;
  readonly reasons: readonly string[];
}

export async function suggestSiteBump(
  db: KobeDb,
  blobs: BlobStore,
  skillId: string,
): Promise<SiteBump | null> {
  const draft = await draftOf(db, skillId);
  if (!draft) return null;
  const versions = await versionRows(db, skillId);
  const newest = newestSemver(versions);
  const top = versions.find((v) => v.semver === newest);
  const stored = top ? await storedVersion(db, skillId, top.id) : null;
  const before = stored ? await packageFiles(blobs, storedOf(stored)) : null;
  const after = await allDraftFiles(db, draft.id);
  const advice = adviseBump(before ?? new Map(), after);
  return {
    rev: draft.rev,
    latest: newest ? { skillId, semver: newest } : null,
    kind: advice.kind,
    suggested: newest && advice.kind ? bumpSemver(newest, advice.kind) : null,
    reasons: advice.reasons,
  };
}
