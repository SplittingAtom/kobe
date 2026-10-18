import { isMap, parseDocument } from "yaml";
import { MANIFEST_PATH, MANIFEST_YAML_OPTIONS } from "@kobe/protocol";

/**
 * A draft's `kobe.skill.yaml` at Save version (KOBE-322). The manifest's `version` and
 * `changelog` must equal the version saved, but a draft's manifest was copied from its parent
 * (a fork) or written before the author chose the number. So the save writes the number and the
 * changelog the author gave into the manifest it packages; every other key stays as written
 * (comments too). A manifest that doesn't parse is left alone: validation then names the problem.
 */
export function withSavedNumber(
  files: ReadonlyMap<string, Uint8Array>,
  semver: string,
  changelog: string,
): Map<string, Uint8Array> {
  const out = new Map(files);
  const raw = files.get(MANIFEST_PATH);
  if (!raw) return out;
  const doc = parseDocument(new TextDecoder().decode(raw), MANIFEST_YAML_OPTIONS);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return out;
  doc.set("version", semver);
  doc.set("changelog", changelog);
  out.set(MANIFEST_PATH, new TextEncoder().encode(doc.toString()));
  return out;
}

/** The manifest without the keys a save writes, to compare two versions' manifests. */
export function manifestWithoutNumber(raw: Uint8Array): string | null {
  const doc = parseDocument(new TextDecoder().decode(raw), MANIFEST_YAML_OPTIONS);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  doc.delete("version");
  doc.delete("changelog");
  return JSON.stringify(doc.toJSON());
}
