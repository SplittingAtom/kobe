import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HttpClient } from "isomorphic-git";
import {
  canonicalZip,
  checkPackagePaths,
  importAllowed,
  type SkillImportOrigin,
  type SkillImportRequest,
} from "@kobe/protocol";
import { SKILL_LIMITS } from "../limits.js";
import { validateZipBundle, type BundleError } from "../bundle.js";
import { readRegistrySettings } from "../registry/settings.js";
import { DRAFT_LIMITS } from "../drafts/files.js";
import { createDraft, type DraftContext } from "../drafts/service.js";
import { packageFiles, type StartResult } from "../drafts/starts.js";
import { fetchGitFiles, fetchZip, ImportError, type ImportErrorCode } from "./fetch.js";
import { guardPacks } from "./pack-guard.js";

/**
 * Governed import (KOBE-344, spec SK30): only from the Site's import allowlist (hosts, or hosts and
 * owners; default none), fetched once by the server through the egress proxy, re-hashed, checked
 * like an upload (package path rules, git-reserved names, SKILL.md, the draft's 5 MiB and 200
 * files) and turned into a private Workbench draft whose `origin` records the URL, the commit,
 * Kobe's own hash and the importer. Never a catalog entry: evals, a version and review follow as
 * for any draft. Nothing is fetched later, at run time or otherwise.
 */

/** A git fetch downloads every branch and tag (the commit must be reachable): bounded here. */
export const IMPORT_FETCH_MAX_BYTES = 64 * 1024 * 1024;
/**
 * What a fetched pack may expand to while isomorphic-git indexes it (review M1): each object at
 * most the upload's per-file limit, all of them together at most 64 MiB.
 */
export const IMPORT_PACK_CAPS = {
  maxObjectBytes: SKILL_LIMITS.maxFileBytes,
  maxTotalBytes: 64 * 1024 * 1024,
};
/** The whole import, fetch and indexing included (review L2). */
export const IMPORT_DEADLINE_MS = 2 * 60_000;
const CAPS = { maxFiles: DRAFT_LIMITS.maxFiles, maxBytes: DRAFT_LIMITS.maxDraftBytes };
/** The draft's own zip is stored, not deflated (as Save version and Save to Workbench). */
const BUNDLE_LIMITS = {
  ...SKILL_LIMITS,
  maxBundleBytes: DRAFT_LIMITS.maxDraftBytes + DRAFT_LIMITS.maxFiles * 1024,
};

export interface ImportDeps {
  /**
   * An HTTP client for one URL's origin, through the egress proxy, that stops at `deadlineAt`
   * (ms since the epoch); null: imports unavailable.
   */
  readonly http: ((url: string, deadlineAt: number) => HttpClient) | null;
  /** Tests: a shorter overall deadline. */
  readonly deadlineMs?: number;
}

export type ImportResult =
  | StartResult
  | { readonly ok: false; readonly error: "not_allowlisted" | "unavailable" }
  | {
      readonly ok: false;
      readonly error: "import_failed";
      readonly code: ImportErrorCode;
      readonly message: string;
    };

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function invalid(bundle: BundleError): StartResult {
  return { ok: false, error: "invalid_bundle", bundle };
}

export async function importSkill(
  ctx: DraftContext,
  deps: ImportDeps,
  request: SkillImportRequest,
  now: Date = new Date(),
): Promise<ImportResult> {
  const { importAllowlist } = await readRegistrySettings(ctx.db);
  if (!importAllowed(importAllowlist, request.url)) return { ok: false, error: "not_allowlisted" };
  if (!deps.http) return { ok: false, error: "unavailable" };
  const deadlineAt = Date.now() + (deps.deadlineMs ?? IMPORT_DEADLINE_MS);
  const http = guardPacks(deps.http(request.url, deadlineAt), IMPORT_PACK_CAPS);
  try {
    if (request.kind === "zip") {
      const bytes = await fetchZip(http, request.url, request.sha256, SKILL_LIMITS.maxBundleBytes);
      const valid = validateZipBundle(bytes);
      if (!valid.ok) return invalid(valid.error);
      const files = packageFiles(valid.value);
      return createDraft(ctx, {
        name: valid.value.name,
        startedFrom: "upload",
        files,
        origin: origin(ctx, request, sha256(bytes), sha256(canonicalZip(files)), now),
      });
    }
    const dir = await mkdtemp(path.join(tmpdir(), "kobe-skill-import-"));
    let files: Map<string, Uint8Array>;
    try {
      files = await fetchGitFiles(http, request.url, request.commit, request.path, dir, CAPS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // The package rules before the zip (they name the paths): git-reserved names, case
    // collisions, an authored provenance.json, a missing SKILL.md.
    const problems = checkPackagePaths(files.keys());
    if (problems.length > 0)
      return invalid({
        code: "unsafe_path",
        message: `The skill's files break the package rules: ${problems
          .slice(0, 5)
          .map((p) => `${p.path} (${p.problem})`)
          .join(", ")}.`,
      });
    // Re-hashed: the draft is exactly these bytes, whatever any ref says now.
    const zip = canonicalZip(files);
    const valid = validateZipBundle(zip, BUNDLE_LIMITS);
    if (!valid.ok) return invalid(valid.error);
    const draftFiles = packageFiles(valid.value);
    return createDraft(ctx, {
      name: valid.value.name,
      startedFrom: "git",
      files: draftFiles,
      origin: origin(ctx, request, sha256(zip), sha256(canonicalZip(draftFiles)), now),
    });
  } catch (err) {
    if (err instanceof ImportError)
      return { ok: false, error: "import_failed", code: err.code, message: err.message };
    throw err;
  }
}

function origin(
  ctx: DraftContext,
  request: SkillImportRequest,
  fetchedSha256: string,
  filesSha256: string,
  now: Date,
): SkillImportOrigin {
  return {
    kind: request.kind,
    // As the URL parser writes it: provenance keeps exactly this form (`href`).
    url: new URL(request.url).href,
    ...(request.kind === "git" ? { commit: request.commit } : {}),
    ...(request.kind === "git" && request.path ? { path: request.path } : {}),
    fetchedSha256,
    filesSha256,
    importedBy: ctx.viewer.userId,
    importedAt: now.toISOString(),
  };
}
