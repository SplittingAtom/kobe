import { createHash } from "node:crypto";
import { canonicalZip } from "../skill-package/canonical-zip.js";
import { hashedPackageFiles, runtimeFiles, type PackageFiles } from "../skill-package/layout.js";

/**
 * The two hashes of a skill package (KOBE-309, spec SK14), lowercase hex SHA-256 of canonical
 * zips (skill-package/canonical-zip.ts):
 *  - runtime hash: of the runtime payload (no `evals/`, `kobe.skill.yaml`, `provenance.json`).
 *    For a bundle with none of those it equals the `content_hash` Kobe has stored since KOBE-78.
 *  - package hash: of everything but `provenance.json`.
 * Callers check the paths first (`checkPackagePaths`).
 */
export interface SkillPackageHashes {
  readonly runtimeHash: string;
  readonly packageHash: string;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The canonical zip of the runtime payload: what a sandbox receives and the blocklist names. */
export const runtimeZip = (files: PackageFiles): Uint8Array => canonicalZip(runtimeFiles(files));

/** The canonical zip of the hashed package (payload, `evals/`, `kobe.skill.yaml`). */
export const packageZip = (files: PackageFiles): Uint8Array =>
  canonicalZip(hashedPackageFiles(files));

export const runtimeHash = (files: PackageFiles): string => sha256Hex(runtimeZip(files));
export const packageHash = (files: PackageFiles): string => sha256Hex(packageZip(files));

export function skillPackageHashes(files: PackageFiles): SkillPackageHashes {
  return { runtimeHash: runtimeHash(files), packageHash: packageHash(files) };
}
