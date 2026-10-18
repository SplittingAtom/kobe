import { unzipSync } from "fflate";
import { canonicalZip, SkillPackageError } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import type { ScanResult } from "@kobe/skill-scanner";
import { previewScanPool, ScanBusyError } from "../scan-pool.js";
import { parseSkillMd } from "../skill-md.js";
import type { SkillStore } from "../skill-store.js";
import { listSkills, type SkillLocation } from "../store.js";
import { adviseBump, bumpSemver, type BumpKind } from "./bump.js";
import { SKILL_MD_PATH } from "./files.js";
import { readAllFiles, visibleDraft, type DraftRecord } from "./records.js";
import type { DraftContext } from "./service.js";

/**
 * What the Workbench editor shows beside a draft (KOBE-321, SK12, SK14): the live scan preview of
 * the draft as stored now, and the bump Save version suggests against the destination's latest
 * version. Both read only what the caller may see (a draft they can't see is not found).
 */

interface Loaded {
  readonly draft: DraftRecord;
  readonly files: Map<string, Uint8Array>;
}

async function loadVisible(ctx: DraftContext, id: string): Promise<Loaded | null> {
  return withTeam(ctx.db, ctx.teamId, async (tx) => {
    const draft = await visibleDraft(tx, ctx.teamId, id, ctx.viewer);
    return draft ? { draft, files: await readAllFiles(tx, ctx.teamId, id) } : null;
  });
}

export type PreviewScan =
  | { readonly ok: true; readonly rev: number; readonly scan: ScanResult }
  | { readonly ok: false; readonly error: "not_found" }
  | { readonly ok: false; readonly error: "busy"; readonly kind: "owner" | "global" };

/**
 * Scans per (team, draft, revision): every change moves a draft to a new revision, so a cached
 * result is the scan of exactly those files. Bounded; the oldest entry goes first.
 */
const CACHE_MAX = 128;
const cache = new Map<string, ScanResult>();

function remember(key: string, scan: ScanResult): void {
  cache.set(key, scan);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Empties the preview cache (tests). */
export function clearPreviewCache(): void {
  cache.clear();
}

/** A scan the preview can't run because the files don't form a package (never stored so). */
function unpackableScan(message: string): ScanResult {
  return {
    verdict: "block",
    ruleSetVersion: "preview",
    scripts: [],
    findings: [
      {
        category: "limit",
        rule: "invalid-package",
        file: "",
        line: 0,
        excerpt: message,
        severity: "block",
      },
    ],
    skipped: [],
  };
}

export async function previewDraftScan(ctx: DraftContext, id: string): Promise<PreviewScan> {
  const loaded = await loadVisible(ctx, id);
  if (!loaded) return { ok: false, error: "not_found" };
  const key = `${ctx.teamId}/${id}/${loaded.draft.rev}`;
  const hit = cache.get(key);
  if (hit) return { ok: true, rev: loaded.draft.rev, scan: hit };
  let zip: Uint8Array;
  try {
    zip = canonicalZip(loaded.files);
  } catch (err) {
    if (!(err instanceof SkillPackageError)) throw err;
    return { ok: true, rev: loaded.draft.rev, scan: unpackableScan(err.message) };
  }
  try {
    const scan = await previewScanPool().scan(zip, { owner: ctx.viewer.userId });
    remember(key, scan);
    return { ok: true, rev: loaded.draft.rev, scan };
  } catch (err) {
    if (err instanceof ScanBusyError) return { ok: false, error: "busy", kind: err.kind };
    throw err;
  }
}

export interface BumpSuggestion {
  readonly rev: number;
  /** The destination's skill of the draft's name and its latest version; null for a new skill. */
  readonly latest: { readonly skillId: string; readonly semver: string } | null;
  /** Null for a new skill, or when nothing changed since `latest`. */
  readonly kind: BumpKind | null;
  /** The suggested number: 0.1.0 for a new skill (the upload's default); null when unchanged. */
  readonly suggested: string | null;
  readonly reasons: readonly string[];
}

export type BumpOutcome =
  | ({ readonly ok: true } & BumpSuggestion)
  | { readonly ok: false; readonly error: "not_found" | "unavailable" };

const FIRST_VERSION = "0.1.0";

/** The skill name a save would use: SKILL.md's when it parses, else the draft's. */
function nameOf(loaded: Loaded): string {
  const md = loaded.files.get(SKILL_MD_PATH);
  const parsed = md ? parseSkillMd(md) : null;
  return parsed && typeof parsed !== "string" ? parsed.name : loaded.draft.name;
}

/**
 * The bump against the latest version of the same-named skill in `destination`: the team's skills,
 * or the caller's own personal skills (never another member's).
 */
export async function suggestDraftBump(
  ctx: DraftContext,
  store: SkillStore,
  id: string,
  destination: "team" | "personal",
): Promise<BumpOutcome> {
  const loaded = await loadVisible(ctx, id);
  if (!loaded) return { ok: false, error: "not_found" };
  const location: SkillLocation =
    destination === "team"
      ? { scope: "team", teamId: ctx.teamId }
      : { scope: "personal", ownerUserId: ctx.viewer.userId };
  const name = nameOf(loaded);
  const skill = (await listSkills(ctx.db, location)).find((s) => s.slug === name) ?? null;
  const rev = loaded.draft.rev;
  if (!skill)
    return { ok: true, rev, latest: null, kind: null, suggested: FIRST_VERSION, reasons: [] };
  const versions = await store.listVersions(location, skill.id);
  const version = versions[0];
  const bytes = version
    ? await store.getPackage(location, version.packageHash ?? version.contentHash)
    : null;
  if (!version || !bytes) return { ok: false, error: "unavailable" };
  const before = new Map(Object.entries(unzipSync(bytes)));
  const advice = adviseBump(before, loaded.files);
  return {
    ok: true,
    rev,
    latest: { skillId: skill.id, semver: version.semver },
    kind: advice.kind,
    suggested: advice.kind ? bumpSemver(version.semver, advice.kind) : null,
    reasons: advice.reasons,
  };
}
