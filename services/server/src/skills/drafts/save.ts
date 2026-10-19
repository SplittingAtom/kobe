import { createHash } from "node:crypto";
import { canonicalZip } from "@kobe/protocol";
import { and, eq, teamSkillVersions, withTeam } from "@kobe/db";
import { teamRoleAllows } from "../../authz/permissions.js";
import { validateZipBundle, type BundleError } from "../bundle.js";
import { SKILL_LIMITS } from "../limits.js";
import { numberingFrom, publishBundle, type PublishResult } from "../publish.js";
import type { SkillStore } from "../skill-store.js";
import type { SkillLocation } from "../store.js";
import { DRAFT_LIMITS, SKILL_MD_PATH } from "./files.js";
import { withSavedNumber } from "./manifest-sync.js";
import { changedBy, readAllFiles, visibleDraft, type DraftRecord } from "./records.js";
import type { DraftContext } from "./service.js";

/**
 * Save version (KOBE-320, SK11, SK14): the draft's files become the next version of a team skill
 * (pending D22 review, Builders and Team admins) or of the author's personal skill. The package
 * goes through the upload's validation (KOBE-78, KOBE-309 path rules), its scan and the store,
 * exactly as an uploaded zip would; the draft stays for the next version. The save names the
 * revision the author saw (a stale one is refused, so nobody ships a co-editor's unseen change).
 *
 * Personal skills load in every team of their author (D5: teams are walls), so a personal save:
 *  - is refused for a draft holding the team's content: a fork of a team (or another member's)
 *    version, or files whose runtime hash is that of any version of one of this team's skills
 *    (a verbatim upload or workspace copy, review S4; only this team's, so the refusal says
 *    nothing about other teams). The way out of the team for that is promotion, or a team save.
 *    An edited copy still passes: an accepted limit (the scan applies, as to every save);
 *  - needs `confirmPersonal` for a draft started from a team conversation (SK11) or changed by
 *    team members (co-edited);
 *  - is always recorded in the team's audit log (`skill.draft.personalized`), with the version.
 */

export interface SaveRequest {
  readonly destination: "team" | "personal";
  readonly semver: string;
  readonly changelog: string;
  readonly confirmPersonal: boolean;
  /** The revision the author saw (`If-Match`). */
  readonly rev: number;
}

export type SaveResult =
  | PublishResult
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 404 | 409 | 413;
      readonly code: string;
      readonly message: string;
      readonly extra?: Record<string, unknown>;
    };

/** The zip of a draft is stored, not deflated: the 5 MiB of files plus headers. */
const DRAFT_BUNDLE_LIMITS = {
  ...SKILL_LIMITS,
  maxBundleBytes: DRAFT_LIMITS.maxDraftBytes + DRAFT_LIMITS.maxFiles * 1024,
};

export async function saveDraftVersion(
  ctx: DraftContext & { readonly teamName: string },
  store: SkillStore,
  id: string,
  request: SaveRequest,
): Promise<SaveResult> {
  const loaded = await withTeam(ctx.db, ctx.teamId, async (tx) => {
    const draft = await visibleDraft(tx, ctx.teamId, id, ctx.viewer);
    if (!draft) return null;
    const by = draft.rev !== request.rev;
    return {
      draft,
      stale: by ? await changedBy(tx, draft.updatedBy) : null,
      files: by ? new Map<string, Uint8Array>() : await readAllFiles(tx, ctx.teamId, id),
    };
  });
  if (!loaded) return refuse(404, "not_found", "No such draft.");
  const { draft, files } = loaded;
  if (loaded.stale)
    return refuse(409, "stale_revision", `This draft was changed by ${loaded.stale.name}.`, {
      rev: draft.rev,
      changedBy: loaded.stale,
    });
  const personal = request.destination === "personal";
  const refused = personal
    ? personalRefusal(ctx, draft, request.confirmPersonal)
    : teamRoleAllows(ctx.viewer.role, "team.skills.publish")
      ? null
      : refuse(403, "forbidden", "Your team role doesn't allow saving team skills.");
  if (refused) return refused;
  const fromConversation = draft.startedFrom === "thread" || draft.fromThreadId !== null;
  if (!files.has(SKILL_MD_PATH))
    return refuse(400, "skill_md_missing", "The draft needs a SKILL.md at its root.");
  // The manifest takes the number and changelog the author chose (a fork's names its parent's).
  const packaged = withSavedNumber(files, request.semver, request.changelog);
  const valid = validateZipBundle(canonicalZip(packaged), DRAFT_BUNDLE_LIMITS);
  if (!valid.ok) return bundleRefusal(valid.error);
  if (personal && (await isTeamVersion(ctx, valid.value.zip)))
    return refuse(409, "team_content", teamContentMessage(ctx.teamName));
  const numbering = numberingFrom(request, valid.value);
  if (!numbering.ok) return refuse(400, "invalid_request", numbering.message);
  const location: SkillLocation = personal
    ? { scope: "personal", ownerUserId: ctx.viewer.userId }
    : { scope: "team", teamId: ctx.teamId };
  return publishBundle(store, location, {
    bundle: valid.value,
    source: "zip",
    uploadedBy: ctx.viewer.userId,
    ...numbering.value,
    draft: {
      id,
      teamId: ctx.teamId,
      personal: personal ? { fromConversation, coEdited: draft.coEdited } : null,
    },
  });
}

/**
 * Whether a fork's parent is content of the team (or of another member): only a catalog version,
 * already Site-wide, or the author's own personal version may become the author's personal skill.
 * Unknown shapes count as team content (fail closed). KOBE-322 writes `parent_ref` as
 * `{kind: "catalog" | "team" | "personal", skillId, semver, hash, ownerUserId?}`.
 */
export function parentIsTeamContent(
  parentRef: Readonly<Record<string, unknown>> | null,
  ownerUserId: string,
): boolean {
  if (parentRef === null) return false;
  if (parentRef.kind === "catalog") return false;
  return !(parentRef.kind === "personal" && parentRef.ownerUserId === ownerUserId);
}

function personalRefusal(
  ctx: DraftContext & { readonly teamName: string },
  draft: DraftRecord,
  confirmed: boolean,
): SaveResult | null {
  if (draft.ownerUserId !== ctx.viewer.userId)
    return refuse(403, "forbidden", "Only the draft's author can save it as their personal skill.");
  if (!teamRoleAllows(ctx.viewer.role, "team.personal.create"))
    return refuse(403, "forbidden", "Your team role doesn't allow personal skills.");
  if (draft.startedFrom === "fork" && parentIsTeamContent(draft.parentRef, draft.ownerUserId))
    return refuse(409, "team_content", teamContentMessage(ctx.teamName));
  const reasons = [
    ...(draft.startedFrom === "thread" || draft.fromThreadId !== null
      ? [`was started from a ${ctx.teamName} conversation`]
      : []),
    ...(draft.coEdited ? [`has changes by other ${ctx.teamName} members`] : []),
  ];
  if (reasons.length > 0 && !confirmed)
    return refuse(
      409,
      "confirm_personal_required",
      `This draft ${reasons.join(" and ")}; personal skills go with you to every team. Confirm to save it as your personal skill.`,
    );
  return null;
}

const teamContentMessage = (teamName: string) =>
  `This draft holds a skill of ${teamName}, which is the team's content and can't become a personal skill. Promote it, or save it as a team skill.`;

/** Whether a runtime zip is, byte for byte, a version of one of this team's skills (RLS too). */
async function isTeamVersion(ctx: DraftContext, runtimeZip: Uint8Array): Promise<boolean> {
  const hash = createHash("sha256").update(runtimeZip).digest("hex");
  const rows = await withTeam(ctx.db, ctx.teamId, (tx) =>
    tx
      .select({ version: teamSkillVersions.version })
      .from(teamSkillVersions)
      .where(and(eq(teamSkillVersions.teamId, ctx.teamId), eq(teamSkillVersions.contentHash, hash)))
      .limit(1),
  );
  return rows.length > 0;
}

function refuse(
  status: 400 | 403 | 404 | 409 | 413,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): SaveResult {
  return { ok: false, status, code, message, ...(extra ? { extra } : {}) };
}

function bundleRefusal(err: BundleError): SaveResult {
  return refuse(
    err.code === "bundle_too_large" || err.code === "file_too_large" ? 413 : 400,
    err.code,
    err.message,
  );
}
