import type { ScanResult } from "@kobe/skill-scanner";
import type { ValidBundle } from "./bundle.js";
import { scanCanonicalZip } from "./review.js";
import { SCAN_RETRY_AFTER_SECONDS, ScanBusyError } from "./scan-pool.js";
import type { SkillStore } from "./skill-store.js";
import type {
  SkillLocation,
  SkillRecord,
  SkillVersionRecord,
  UploadDraft,
  UploadError,
} from "./store.js";

/**
 * Storing a validated bundle as a new version: the whole-tree scan (SK32), then the store, with
 * every refusal as the HTTP answer the upload route (KOBE-78) and a draft's Save version
 * (KOBE-320) give alike.
 */

export interface PublishInput {
  readonly bundle: ValidBundle;
  readonly source: "zip" | "skill_md";
  readonly uploadedBy: string;
  readonly semver?: string;
  readonly changelog?: string;
  /** The Workbench draft saved (KOBE-320): audited with the version. */
  readonly draft?: UploadDraft;
}

export type PublishResult =
  | {
      readonly ok: true;
      readonly skill: SkillRecord;
      readonly version: SkillVersionRecord;
      readonly scan: ScanResult;
    }
  | {
      readonly ok: false;
      readonly status: 400 | 409 | 422 | 429 | 503;
      readonly code: string;
      readonly message: string;
      readonly retryAfter?: number;
    };

const STORE_ERRORS: Record<
  Exclude<UploadError, "semver_not_increasing" | "semver_required">,
  string
> = {
  unchanged: "That bundle is identical to the current version.",
  skill_limit: "This location has reached its limit of skills.",
  version_limit: "This skill has reached its limit of versions.",
  blocklisted: "This skill bundle is on the site's blocklist and can't be uploaded.",
  name_clash:
    "The team has installed a catalog skill with this name. Uninstall it or choose another name.",
  reserved_name: "That name belongs to one of Kobe's own skills. Choose another name.",
};

export async function publishBundle(
  store: SkillStore,
  location: SkillLocation,
  input: PublishInput,
): Promise<PublishResult> {
  const { bundle } = input;
  let scan: ScanResult;
  try {
    scan = await scanCanonicalZip(bundle.packageZip ?? bundle.zip, { owner: input.uploadedBy });
  } catch (err) {
    if (!(err instanceof ScanBusyError)) throw err;
    return err.kind === "owner"
      ? {
          ok: false,
          status: 429,
          code: "scan_busy",
          message: "Your earlier uploads are still being scanned. Try again shortly.",
          retryAfter: SCAN_RETRY_AFTER_SECONDS,
        }
      : {
          ok: false,
          status: 503,
          code: "scan_busy",
          message: "Skill scanning is busy. Try again shortly.",
          retryAfter: SCAN_RETRY_AFTER_SECONDS,
        };
  }
  const result = await store.putPackage(location, {
    bundle,
    source: input.source,
    uploadedBy: input.uploadedBy,
    scan,
    ...(input.semver ? { semver: input.semver } : {}),
    ...(input.changelog ? { changelog: input.changelog } : {}),
    ...(input.draft ? { draft: input.draft } : {}),
  });
  if (result.ok) return { ok: true, skill: result.skill, version: result.version, scan };
  switch (result.error) {
    case "semver_not_increasing":
      return {
        ok: false,
        status: 409,
        code: result.error,
        message: `Version ${input.semver ?? ""} must be higher than the latest version, ${result.latest}.`,
      };
    case "semver_required":
      return {
        ok: false,
        status: 400,
        code: result.error,
        message: `The next version after ${result.latest} can't be numbered automatically: give a semver (for example a new major).`,
      };
    case "blocklisted":
      return {
        ok: false,
        status: 422,
        code: "skill_blocklisted",
        message: STORE_ERRORS.blocklisted,
      };
    default:
      return { ok: false, status: 409, code: result.error, message: STORE_ERRORS[result.error] };
  }
}

/**
 * The number and changelog of a version: as given, or from the package's `kobe.skill.yaml`
 * (KOBE-309). When both give one, they must agree: the manifest never renumbers a version behind
 * the author's back.
 */
export function numberingFrom(
  given: { readonly semver?: string | undefined; readonly changelog?: string | undefined },
  bundle: ValidBundle,
): { ok: true; value: { semver?: string; changelog?: string } } | { ok: false; message: string } {
  const manifest = bundle.manifest;
  if (manifest && given.semver !== undefined && given.semver !== manifest.version)
    return {
      ok: false,
      message: `semver ${given.semver} differs from kobe.skill.yaml's version ${manifest.version}.`,
    };
  if (
    manifest?.changelog &&
    given.changelog !== undefined &&
    given.changelog !== manifest.changelog
  )
    return { ok: false, message: "The changelog differs from kobe.skill.yaml's changelog." };
  const semver = given.semver ?? manifest?.version;
  const changelog = given.changelog ?? manifest?.changelog;
  return {
    ok: true,
    value: { ...(semver ? { semver } : {}), ...(changelog ? { changelog } : {}) },
  };
}
