import { createHash } from "node:crypto";
import { canonicalZip } from "../skill-package/canonical-zip.js";
import {
  assertPackagePaths,
  hashedPackageFiles,
  runtimeFiles,
  type CheckPackageOptions,
  type PackageFiles,
} from "../skill-package/layout.js";

/**
 * The two hashes of a skill package (KOBE-309, spec SK14), lowercase hex SHA-256 of canonical
 * zips (skill-package/canonical-zip.ts):
 *  - runtime hash: of the runtime payload (no `evals/`, `kobe.skill.yaml`, `provenance.json`).
 *    For a bundle with none of those it equals the `content_hash` Kobe has stored since KOBE-78.
 *  - package hash: of everything but `provenance.json`.
 * Every function checks the whole file set first (`checkPackagePaths`, with `options`) and throws
 * `SkillPackageError` for an invalid package: a `provenance.json` is accepted only with
 * `{ kobeProvenance: true }` (a package Kobe assembled), never in authored content.
 */
export interface SkillPackageHashes {
  readonly runtimeHash: string;
  readonly packageHash: string;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The canonical zip of the runtime payload: what a sandbox receives and the blocklist names. */
export function runtimeZip(files: PackageFiles, options: CheckPackageOptions = {}): Uint8Array {
  assertPackagePaths(files.keys(), options);
  return canonicalZip(runtimeFiles(files));
}

/** The canonical zip of the hashed package (payload, `evals/`, `kobe.skill.yaml`). */
export function packageZip(files: PackageFiles, options: CheckPackageOptions = {}): Uint8Array {
  assertPackagePaths(files.keys(), options);
  return canonicalZip(hashedPackageFiles(files));
}

export const runtimeHash = (files: PackageFiles, options: CheckPackageOptions = {}): string =>
  sha256Hex(runtimeZip(files, options));
export const packageHash = (files: PackageFiles, options: CheckPackageOptions = {}): string =>
  sha256Hex(packageZip(files, options));

export function skillPackageHashes(
  files: PackageFiles,
  options: CheckPackageOptions = {},
): SkillPackageHashes {
  return { runtimeHash: runtimeHash(files, options), packageHash: packageHash(files, options) };
}
