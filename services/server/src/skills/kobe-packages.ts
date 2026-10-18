import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KOBE_SKILL_NAMES, canonicalZip, type KobeSkillManifest } from "@kobe/protocol";
import { validateZipBundle, type ValidBundle } from "./bundle.js";

/**
 * The package set of Kobe's own catalog skills (KOBE-317, SK4): the former built-ins, one
 * directory per skill under `services/server/builtin-skills/<name>/`, shipped with the server
 * image (so a Kobe release updates them without a sandbox image rebuild). Each holds the skill's
 * files and a `kobe.skill.yaml` whose `version` is the catalog semver: changing a skill's files
 * means raising it (`kobe-packages.test.ts` holds each version's hash).
 *
 * Every package goes through the upload's own checks (`validateZipBundle`: limits, paths,
 * SKILL.md, manifest), so a Kobe skill is held to the rules a member's upload is.
 */
export const KOBE_PACKAGES_DIR = fileURLToPath(new URL("../../builtin-skills", import.meta.url));

export interface KobePackage {
  readonly name: string;
  readonly semver: string;
  readonly manifest: KobeSkillManifest;
  readonly bundle: ValidBundle;
}

export class KobePackageError extends Error {
  constructor(message: string) {
    super(`skills: Kobe package set: ${message}`);
    this.name = "KobePackageError";
  }
}

/** The files of one package directory, by relative `/` path; symlinks and specials refused. */
async function readTree(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of (await readdir(dir)).sort()) {
      const full = path.join(dir, entry);
      const at = rel === "" ? entry : `${rel}/${entry}`;
      const info = await lstat(full);
      if (info.isDirectory()) await walk(full, at);
      else if (info.isFile()) files.set(at, new Uint8Array(await readFile(full)));
      else throw new KobePackageError(`${at} is not a regular file`);
    }
  };
  await walk(root, "");
  return files;
}

/** One package: its directory's files as a checked bundle with a manifest naming it. */
export async function readKobePackage(dir: string, name: string): Promise<KobePackage> {
  const files = await readTree(path.join(dir, name));
  const checked = validateZipBundle(canonicalZip(files));
  if (!checked.ok) throw new KobePackageError(`${name}: ${checked.error.message}`);
  const bundle = checked.value;
  if (bundle.name !== name)
    throw new KobePackageError(`${name}: SKILL.md names ${bundle.name}, not its directory`);
  if (!bundle.manifest) throw new KobePackageError(`${name}: kobe.skill.yaml is missing`);
  return { name, semver: bundle.manifest.version, manifest: bundle.manifest, bundle };
}

/** The whole set, in `KOBE_SKILL_NAMES` order: exactly those directories, nothing else. */
export async function loadKobePackages(dir: string = KOBE_PACKAGES_DIR): Promise<KobePackage[]> {
  const present = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
  const expected = [...KOBE_SKILL_NAMES].sort();
  if (present.join(",") !== expected.join(","))
    throw new KobePackageError(`expected ${expected.join(", ")}, found ${present.join(", ")}`);
  const out: KobePackage[] = [];
  for (const name of KOBE_SKILL_NAMES) out.push(await readKobePackage(dir, name));
  return out;
}
