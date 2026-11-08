import { MANIFEST_PATH, type KobeSkillManifest } from "@kobe/protocol";
import { withTeam, type KobeDb, type TeamRole } from "@kobe/db";
import { recordAudit } from "../../audit/record.js";
import { teamRoleAllows } from "../../authz/permissions.js";
import type { BlobStore } from "../../retention/blobs.js";
import { startFork, versionFiles } from "../drafts/fork.js";
import type { DraftFailure } from "../drafts/service.js";
import type { DraftRecord } from "../drafts/records.js";
import type { SkillManifestFailure, SkillManifestGenerator } from "../manifest/index.js";
import type { SkillStore } from "../skill-store.js";
import { findSkill, type SkillLocation } from "../store.js";
import type { PromoteSource } from "./promote-check.js";

/**
 * Create kobe.skill.yaml for a version that has none (KOBE-564): what the Promote panel offers
 * when SK20 refuses a version with `no_manifest`. A stored version is immutable (its hashes are
 * its identity), so the manifest cannot be added to it: Kobe drafts the file with the model the
 * member chose, then forks the version into a new Workbench draft of the member's with the file in
 * place, at one revision. The member reviews it there, saves the next version (a new package
 * hash, so the full evals run again, SK20) and promotes that one. Nothing leaves the team here:
 * the model call goes through the gateway under the member's own budget, and the draft is private
 * to them.
 */

export interface ManifestDraftDeps {
  readonly db: KobeDb;
  readonly store: SkillStore;
  readonly blobs: BlobStore;
  readonly generator: SkillManifestGenerator;
}

export interface ManifestDraftChoice {
  /** The catalog alias the member picked; undefined: the team default. */
  readonly model?: string | undefined;
  /** The author's license (SPDX or `Proprietary`); undefined: the manifest has none yet. */
  readonly license?: string | undefined;
  /**
   * Called right before the model call, after the cheap refusals (review L3): the route's rate
   * limit, so a 404 or `has_manifest` never counts. False: `rate_limited`.
   */
  readonly admit?: () => Promise<boolean>;
}

export type ManifestDraftResult =
  | {
      readonly ok: true;
      readonly draft: DraftRecord;
      readonly manifest: KobeSkillManifest;
      readonly model: { readonly alias: string; readonly gatewayModel: string };
      readonly source: "model" | "seed";
    }
  | {
      readonly ok: false;
      readonly code:
        | "not_found"
        | "forbidden"
        | "has_manifest"
        | "blocklisted"
        | "unavailable"
        | "rate_limited"
        | SkillManifestFailure
        | DraftFailure["error"];
      readonly message: string;
      readonly detail?: string;
    };

const refuse = (
  code: Extract<ManifestDraftResult, { ok: false }>["code"],
  message: string,
  detail?: string,
): ManifestDraftResult => ({ ok: false, code, message, ...(detail ? { detail } : {}) });

const locationOf = (source: PromoteSource, userId: string): SkillLocation =>
  source.scope === "team"
    ? { scope: "team", teamId: source.teamId }
    : { scope: "personal", ownerUserId: userId };

export async function createManifestDraft(
  deps: ManifestDraftDeps,
  source: PromoteSource,
  who: { readonly userId: string; readonly role: TeamRole },
  choice: ManifestDraftChoice,
): Promise<ManifestDraftResult> {
  if (!teamRoleAllows(who.role, "team.personal.create"))
    return refuse("forbidden", "Your team role doesn't allow drafts.");
  if (source.scope === "team" && !teamRoleAllows(who.role, "team.skills.publish"))
    return refuse("forbidden", "Only Builders and Team admins promote team skills.");
  const ctx = { db: deps.db, teamId: source.teamId, viewer: who };
  const location = locationOf(source, who.userId);
  const skill = await findSkill(deps.db, location, source.skillId);
  if (!skill) return refuse("not_found", "No such skill version.");
  const forkSource = { kind: source.scope, skillId: source.skillId, version: source.version };
  const read = await versionFiles(ctx, deps.store, forkSource);
  if (!read.ok) {
    if (read.error === "blocklisted")
      return refuse("blocklisted", "That version is on the site's blocklist.");
    if (read.error === "source_unavailable")
      return refuse("unavailable", "That version's files can't be read yet.");
    return refuse("not_found", "No such skill version.");
  }
  if (read.files.has(MANIFEST_PATH))
    return refuse("has_manifest", "This version already has a kobe.skill.yaml.");
  const semver =
    (await deps.store.listVersions(location, source.skillId)).find(
      (v) => v.version === source.version,
    )?.semver ?? skill.latestSemver;
  if (choice.admit && !(await choice.admit()))
    return refuse("rate_limited", "Too many manifests. Wait a few minutes and try again.");
  const made = await deps.generator.generate({
    teamId: source.teamId,
    userId: who.userId,
    modelAlias: choice.model,
    name: skill.slug,
    semver,
    files: read.files,
    license: choice.license,
  });
  if (!made.ok) return refuse(made.code, made.message, made.detail);
  const fork = await startFork(
    ctx,
    { store: deps.store, blobs: deps.blobs },
    forkSource,
    undefined,
    new Map([[MANIFEST_PATH, made.yaml]]),
  );
  if (!fork.ok) {
    if (fork.error === "invalid_bundle") return refuse("unavailable", fork.bundle.message);
    if (fork.error === "blocklisted")
      return refuse("blocklisted", "That version is on the site's blocklist.");
    if (fork.error === "source_not_found" || fork.error === "source_unavailable")
      return refuse("unavailable", "That version's files can't be copied yet.");
    const failure = draftFailureOf(fork);
    return refuse(failure.error, messageOf(failure));
  }
  await withTeam(deps.db, source.teamId, (tx) =>
    recordAudit(tx, {
      action: "skill.manifest.generated",
      teamId: source.teamId,
      target: {
        draftId: fork.draft.id,
        skillId: source.skillId,
        scope: source.scope,
        version: source.version,
        semver,
        model: made.model.alias,
        from: made.source,
      },
    }),
  );
  return {
    ok: true,
    draft: fork.draft,
    manifest: made.manifest,
    model: made.model,
    source: made.source,
  };
}

const SOURCE_ERRORS: ReadonlySet<string> = new Set([
  "blocklisted",
  "source_not_found",
  "source_unavailable",
]);

/** The fork's failure as the draft layer's (the source cases were answered before). */
function draftFailureOf(failure: { readonly error: string }): DraftFailure {
  if (SOURCE_ERRORS.has(failure.error) || failure.error === "invalid_bundle")
    throw new Error(`unexpected fork failure ${failure.error}`);
  return failure as DraftFailure;
}

/** A draft failure's text for the member (the route maps codes to statuses). */
export function messageOf(failure: DraftFailure): string {
  switch (failure.error) {
    case "forbidden":
    case "invalid_path":
    case "name_taken":
    case "draft_too_large":
    case "file_too_large":
      return failure.message;
    case "draft_limit":
      return "You have as many drafts in this team as one author may. Delete one first.";
    case "too_many_files":
      return "The version has more files than a draft may hold.";
    case "stale_revision":
      return "The draft changed meanwhile. Reload it and try again.";
    case "not_sync_target":
      return "This draft is no longer saved into.";
    case "not_found":
      return "No such draft.";
  }
}
