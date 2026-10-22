import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import {
  EVALS_DIR,
  PROVENANCE_PATH,
  canonicalJsonBytes,
  deterministicZip,
  runtimeFiles,
  type SkillProvenance,
} from "@kobe/protocol";
import { SKILL_LIMITS } from "./limits.js";

/**
 * Exports (KOBE-345, spec SK30): any version as a portable SKILL.md zip (the runtime payload,
 * with or without `evals/`; never `kobe.skill.yaml` or `provenance.json`), and a catalog
 * version as its full package (payload, `evals/`, `kobe.skill.yaml` and Kobe's
 * `provenance.json`, the mirror's `skills/<name>/` layout). Every zip has one `<name>/` folder,
 * so it unpacks into `.agents/skills/` or a Pi `--skill <dir>` as is, and Kobe's own upload and
 * import strip that folder. Bytes are deterministic (fixed order and timestamps): the same
 * version always exports to the same SHA-256, which an import can pin.
 */
export type ExportFormat = "portable" | "portable_evals" | "package";

export class ExportTooLargeError extends Error {
  constructor() {
    super("The export is larger than a skill may be.");
  }
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** The files of a stored package zip (the package hash covers exactly these). */
export function filesOfPackage(zip: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let total = 0;
  for (const [path, bytes] of Object.entries(unzipSync(zip))) {
    if (path.endsWith("/") || path === PROVENANCE_PATH) continue;
    total += bytes.length;
    if (total > SKILL_LIMITS.maxUncompressedBytes) throw new ExportTooLargeError();
    out.set(path, bytes);
  }
  return out;
}

/** What goes in an export of `format`, by package path (before the `<name>/` folder). */
export function exportFiles(
  files: ReadonlyMap<string, Uint8Array>,
  format: ExportFormat,
  provenance: SkillProvenance | null,
): Map<string, Uint8Array> {
  if (format === "package") {
    const out = new Map(files);
    if (provenance) out.set(PROVENANCE_PATH, canonicalJsonBytes(provenance));
    return out;
  }
  const out = new Map(runtimeFiles(files));
  if (format === "portable_evals")
    for (const [p, b] of files) if (p.startsWith(EVALS_DIR)) out.set(p, b);
  return out;
}

export interface Exported {
  readonly zip: Uint8Array;
  readonly sha256: string;
  readonly filename: string;
}

export function exportZip(
  name: string,
  semver: string,
  files: ReadonlyMap<string, Uint8Array>,
  format: ExportFormat,
  provenance: SkillProvenance | null,
): Exported {
  const chosen = exportFiles(files, format, provenance);
  const zip = deterministicZip(new Map([...chosen].map(([p, b]) => [`${name}/${p}`, b])));
  const suffix = format === "package" ? "-package" : format === "portable_evals" ? "-evals" : "";
  return { zip, sha256: sha256(zip), filename: `${name}-v${semver}${suffix}.zip` };
}

/** The download response for an export. */
export function exportResponse(e: Exported): Response {
  return new Response(new Uint8Array(e.zip), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-length": String(e.zip.length),
      "content-disposition": `attachment; filename="${e.filename}"`,
      // Pin it on import (KOBE-344): the same version always exports to these bytes.
      "x-kobe-sha256": e.sha256,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
