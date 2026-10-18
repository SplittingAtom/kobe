import { checkPackagePaths, type PackageProblemCode } from "@kobe/protocol";

/**
 * A new Workbench file's path, checked in the browser with the package contract's own validator
 * (`checkPackagePaths`, KOBE-309) before it is sent; the server checks again.
 */
const MESSAGES: Readonly<Record<PackageProblemCode, string>> = {
  empty: "Give the file a path, such as references/guide.md.",
  too_long: "The path is longer than 240 bytes.",
  not_well_formed: "The path has broken characters.",
  not_nfc: "Retype the path: it has characters in an unusual Unicode form.",
  absolute: "Use a path relative to the skill folder.",
  control_or_backslash: "Use / between folders, without control characters or \\.",
  invisible_or_bidi: "The path has invisible or direction characters.",
  bad_segment: "The path has an empty, . or .. folder name.",
  duplicate: "Another file has this path in a different case.",
  file_and_directory: "That path is both a file and a folder.",
  reserved_name_case:
    "Only SKILL.md, evals/ and kobe.skill.yaml are special: spell them exactly so.",
  reserved_directory: "evals is a folder: put files inside it.",
  provenance_not_allowed: "Kobe writes provenance.json itself.",
  skill_md_missing: "",
};

/** Why `path` can't be added next to `others` (the draft's paths); null when it can. */
export function newPathProblem(path: string, others: readonly string[]): string | null {
  if (others.includes(path)) return "A file already has this path.";
  const problem = checkPackagePaths([...others, path]).find(
    (p) =>
      p.problem !== "skill_md_missing" && (p.path === path || p.problem === "file_and_directory"),
  );
  return problem ? MESSAGES[problem.problem] : null;
}
