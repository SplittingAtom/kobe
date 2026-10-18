import { checkPackagePaths, type PackageProblemCode } from "@kobe/protocol";
import { SKILL_DRAFT_MAX_BYTES } from "@kobe/db";
import { SKILL_LIMITS } from "../limits.js";

/**
 * The rules a draft's files follow (KOBE-320, SK11): the package contract's paths for authored
 * content (KOBE-309: no `provenance.json`, reserved names spelled exactly, no file/folder clash),
 * the upload's file count and SKILL.md cap, and 5 MiB for the whole draft (the database caps it
 * too). Checked on every write, so a draft is always a package the upload path would read.
 */

export const DRAFT_LIMITS = {
  maxDraftBytes: SKILL_DRAFT_MAX_BYTES,
  maxFiles: SKILL_LIMITS.maxFiles,
  maxSkillMdBytes: SKILL_LIMITS.maxSkillMdBytes,
  /** Drafts per author in one team. */
  maxDraftsPerAuthor: 50,
} as const;

/** File writes per user across drafts (autosave included); over it: 429. */
export const DRAFT_WRITE_RATE = { windowMs: 10 * 60_000, max: 1200 } as const;

/** Scan previews and bump suggestions per user (KOBE-321): one a second on average; over it: 429. */
export const DRAFT_PREVIEW_RATE = { windowMs: 10 * 60_000, max: 600 } as const;

export const SKILL_MD_PATH = "SKILL.md";

const PROBLEM_TEXT: Partial<Record<PackageProblemCode, string>> = {
  duplicate: "another file has this path in a different case",
  file_and_directory: "it is both a file and a folder",
  reserved_name_case: "only SKILL.md, evals/ and kobe.skill.yaml, spelled exactly so, are special",
  reserved_directory: "evals is a folder",
  provenance_not_allowed: "Kobe writes provenance.json itself",
};

/**
 * The file path of a `/files/<path>` URL: each segment percent-decoded on its own (a decoded `/`
 * is refused, so `..%2Fx` can't smuggle a segment), or null when it doesn't decode.
 */
export function pathFromUrl(rest: string): string | null {
  const segments = rest.split("/");
  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (value.includes("/")) return null;
    decoded.push(value);
  }
  return decoded.join("/");
}

/**
 * Why `path` can't be written next to `others` (the draft's other paths), or null. The draft may
 * lack SKILL.md while it is being written: only Save version requires it.
 */
export function draftPathProblem(path: string, others: readonly string[]): string | null {
  const problems = checkPackagePaths([...others.filter((p) => p !== path), path]).filter(
    (p) => p.problem !== "skill_md_missing",
  );
  const mine = problems.find((p) => p.path === path) ?? problems[0];
  if (!mine) return null;
  return (
    PROBLEM_TEXT[mine.problem] ?? `the path is not allowed (${mine.problem.replaceAll("_", " ")})`
  );
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Text (valid UTF-8 without NUL) is stored inline; anything else as bytes. */
export function draftContent(
  bytes: Uint8Array,
): { readonly text: string } | { readonly bytes: Buffer } {
  if (!bytes.includes(0)) {
    try {
      return { text: utf8.decode(bytes) };
    } catch {
      // Not UTF-8: stored as bytes.
    }
  }
  return { bytes: Buffer.from(bytes) };
}

/** The SKILL.md a blank draft starts with (the name rules hold, the description is a prompt). */
export function skeletonSkillMd(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: Say what this skill does and when to use it.",
    "---",
    "",
    `# ${name}`,
    "",
    "Write the instructions here.",
    "",
  ].join("\n");
}
