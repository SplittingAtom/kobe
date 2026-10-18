import { canonicalZip } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { teamRoleAllows } from "../../authz/permissions.js";
import { validateZipBundle, type BundleError } from "../bundle.js";
import { SKILL_LIMITS } from "../limits.js";
import { numberingFrom, publishBundle, type PublishResult } from "../publish.js";
import type { SkillStore } from "../skill-store.js";
import type { SkillLocation } from "../store.js";
import { DRAFT_LIMITS, SKILL_MD_PATH } from "./files.js";
import { changedBy, readAllFiles, visibleDraft } from "./records.js";
import type { DraftContext } from "./service.js";

/**
 * Save version (KOBE-320, SK11, SK14): the draft's files become the next version of a team skill
 * (pending D22 review, Builders and Team admins) or of the author's personal skill. The package
 * goes through the upload's validation (KOBE-78, KOBE-309 path rules), its scan and the store,
 * exactly as an uploaded zip would; the draft stays for the next version. A personal save of a
 * draft started from a team conversation needs `confirmPersonal` and is audited
 * (`skill.draft.personalized`) with the version.
 */

export interface SaveRequest {
  readonly destination: "team" | "personal";
  readonly semver: string;
  readonly changelog: string;
  readonly confirmPersonal: boolean;
  /** The revision the author saw (`If-Match`); the draft as it is now when absent. */
  readonly rev?: number;
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
    const by = request.rev !== undefined && draft.rev !== request.rev;
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
  if (personal && draft.ownerUserId !== ctx.viewer.userId)
    return refuse(403, "forbidden", "Only the draft's author can save it as their personal skill.");
  if (!personal && !teamRoleAllows(ctx.viewer.role, "team.skills.publish"))
    return refuse(403, "forbidden", "Your team role doesn't allow saving team skills.");
  const fromConversation = draft.fromThreadId !== null;
  if (personal && fromConversation && !request.confirmPersonal)
    return refuse(
      409,
      "confirm_personal_required",
      `This draft was started from a ${ctx.teamName} conversation; personal skills go with you to every team. Confirm to save it as your personal skill.`,
    );
  if (!files.has(SKILL_MD_PATH))
    return refuse(400, "skill_md_missing", "The draft needs a SKILL.md at its root.");
  const valid = validateZipBundle(canonicalZip(files), DRAFT_BUNDLE_LIMITS);
  if (!valid.ok) return bundleRefusal(valid.error);
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
    draft: { id, teamId: ctx.teamId, personalized: personal && fromConversation },
  });
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
