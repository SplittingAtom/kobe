import { unzipSync } from "fflate";
import { isMap, parseDocument } from "yaml";
import { MANIFEST_PATH, MANIFEST_YAML_OPTIONS } from "@kobe/protocol";
import {
  and,
  eq,
  inArray,
  registrySkills,
  registryVersions,
  teamSkillBlocks,
  teamSkillInstalls,
  withTeam,
  type KobeDb,
} from "@kobe/db";
import type { BlobStore } from "../../retention/blobs.js";
import { readVerified } from "../blob-read.js";
import { isBlocked } from "../blocklist.js";
import type { SkillStore } from "../skill-store.js";
import type { SkillLocation } from "../store.js";
import { SKILL_MD_PATH } from "./files.js";
import { createDraft, type DraftContext } from "./service.js";
import type { StartResult } from "./starts.js";

/**
 * Fork (KOBE-322, spec SK10 start 3): a copy of a version the caller can read, as a new draft.
 * The parent is recorded from the version actually copied (the fork-parent contract, KOBE-320):
 * `{kind, skillId, semver, hash, ownerUserId?}`, never from the request. Sources: a version of a
 * team skill, of the caller's own personal skill, or of a catalog skill the team has installed
 * (its installed version, or another published one). A blocklisted version is not copied.
 *
 * This is also how an existing skill is edited: fork it under its own name, change it, and save
 * it back as its next version.
 */

export type ForkSource =
  | {
      readonly kind: "team" | "personal";
      readonly skillId: string;
      readonly version?: number | undefined;
    }
  | { readonly kind: "catalog"; readonly skillId: string; readonly semver?: string | undefined };

export type ForkResult =
  | StartResult
  | {
      readonly ok: false;
      readonly error: "source_not_found" | "source_unavailable" | "blocklisted";
    };

interface Copied {
  readonly files: Map<string, Uint8Array>;
  readonly parentRef: Record<string, unknown>;
}

type Copy = Copied | "source_not_found" | "source_unavailable" | "blocklisted";

const PUBLISHED = ["approved", "deprecated"] as const;

async function copyLocal(
  ctx: DraftContext,
  store: SkillStore,
  source: Extract<ForkSource, { kind: "team" | "personal" }>,
): Promise<Copy> {
  const location: SkillLocation =
    source.kind === "team"
      ? { scope: "team", teamId: ctx.teamId }
      : { scope: "personal", ownerUserId: ctx.viewer.userId };
  const versions = await store.listVersions(location, source.skillId);
  const version =
    source.version === undefined ? versions[0] : versions.find((v) => v.version === source.version);
  if (!version) return "source_not_found";
  if (await withTeam(ctx.db, ctx.teamId, (tx) => isBlocked(tx, version.contentHash)))
    return "blocklisted";
  const bytes = await store.getPackage(location, version.packageHash ?? version.contentHash);
  if (!bytes) return "source_unavailable";
  return {
    files: new Map(Object.entries(unzipSync(bytes))),
    parentRef: {
      kind: source.kind,
      skillId: source.skillId,
      semver: version.semver,
      hash: version.contentHash,
      ...(source.kind === "personal" ? { ownerUserId: ctx.viewer.userId } : {}),
    },
  };
}

async function copyCatalog(
  ctx: DraftContext,
  db: KobeDb,
  blobs: BlobStore,
  source: Extract<ForkSource, { kind: "catalog" }>,
): Promise<Copy> {
  const found = await withTeam(db, ctx.teamId, async (tx) => {
    const [install] = await tx
      .select({ versionId: teamSkillInstalls.versionId })
      .from(teamSkillInstalls)
      .where(
        and(
          eq(teamSkillInstalls.teamId, ctx.teamId),
          eq(teamSkillInstalls.skillId, source.skillId),
        ),
      );
    if (!install) return null;
    // An archived catalog skill, or one this team blocked, is not there to copy (review N4).
    const [skill] = await tx
      .select({ status: registrySkills.status })
      .from(registrySkills)
      .where(eq(registrySkills.id, source.skillId));
    if (!skill || skill.status === "archived") return null;
    const [blocked] = await tx
      .select({ skillId: teamSkillBlocks.skillId })
      .from(teamSkillBlocks)
      .where(
        and(eq(teamSkillBlocks.teamId, ctx.teamId), eq(teamSkillBlocks.skillId, source.skillId)),
      );
    if (blocked) return null;
    const [version] = await tx
      .select()
      .from(registryVersions)
      .where(
        and(
          eq(registryVersions.skillId, source.skillId),
          source.semver === undefined
            ? eq(registryVersions.id, install.versionId)
            : eq(registryVersions.semver, source.semver),
          inArray(registryVersions.state, [...PUBLISHED]),
        ),
      );
    if (!version) return null;
    return { version, blocked: await isBlocked(tx, version.runtimeHash) };
  });
  if (!found) return "source_not_found";
  const { version, blocked } = found;
  if (blocked) return "blocklisted";
  const packaged = version.packageStorageKey !== null;
  const key = version.packageStorageKey ?? version.runtimeStorageKey;
  if (!key) return "source_unavailable";
  const bytes = await readVerified(
    blobs,
    key,
    packaged ? version.packageHash : version.runtimeHash,
    packaged ? null : version.runtimeSizeBytes,
  );
  if (!bytes) return "source_unavailable";
  return {
    files: new Map(Object.entries(unzipSync(bytes))),
    parentRef: {
      kind: "catalog",
      skillId: source.skillId,
      semver: version.semver,
      hash: version.runtimeHash,
    },
  };
}

const FENCE = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;

/** The files under a new skill name: SKILL.md's frontmatter and the manifest's `name`. */
export function renamed(
  files: ReadonlyMap<string, Uint8Array>,
  name: string,
): Map<string, Uint8Array> {
  const out = new Map(files);
  const md = files.get(SKILL_MD_PATH);
  const text = md ? new TextDecoder().decode(md) : "";
  const fence = FENCE.exec(text);
  if (fence) {
    const doc = parseDocument(fence[2] ?? "", { schema: "core" });
    if (doc.errors.length === 0 && isMap(doc.contents)) {
      doc.set("name", name);
      const head = doc.toString().replace(/\n$/, "");
      const next = `${fence[1]}${head}${fence[3]}${text.slice(fence[0].length)}`;
      out.set(SKILL_MD_PATH, new TextEncoder().encode(next));
    }
  }
  const manifest = files.get(MANIFEST_PATH);
  if (manifest) {
    const doc = parseDocument(new TextDecoder().decode(manifest), MANIFEST_YAML_OPTIONS);
    if (doc.errors.length === 0 && isMap(doc.contents)) {
      doc.set("name", name);
      out.set(MANIFEST_PATH, new TextEncoder().encode(doc.toString()));
    }
  }
  return out;
}

/** The skill name a SKILL.md gives (its frontmatter `name`), or null. */
function nameIn(files: ReadonlyMap<string, Uint8Array>): string | null {
  const md = files.get(SKILL_MD_PATH);
  const fence = md ? FENCE.exec(new TextDecoder().decode(md)) : null;
  const doc = fence ? parseDocument(fence[2] ?? "", { schema: "core" }) : null;
  const name: unknown = doc && doc.errors.length === 0 ? doc.get("name") : null;
  return typeof name === "string" ? name : null;
}

export async function startFork(
  ctx: DraftContext,
  deps: { readonly store: SkillStore; readonly blobs: BlobStore },
  source: ForkSource,
  name?: string,
): Promise<ForkResult> {
  const copy =
    source.kind === "catalog"
      ? await copyCatalog(ctx, ctx.db, deps.blobs, source)
      : await copyLocal(ctx, deps.store, source);
  if (typeof copy === "string") return { ok: false, error: copy };
  // Kobe writes provenance.json itself on export; a copy never carries one (authored content).
  copy.files.delete("provenance.json");
  const original = nameIn(copy.files);
  const target = name ?? original;
  if (!target) return { ok: false, error: "source_unavailable" };
  const files = target === original ? copy.files : renamed(copy.files, target);
  return createDraft(ctx, { name: target, startedFrom: "fork", parentRef: copy.parentRef, files });
}
