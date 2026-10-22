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
  git_reserved: "Git uses .git, .gitattributes and .gitmodules itself: rename it.",
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

/** A typed folder name as a path: trimmed, without one trailing / (KOBE-478). */
export const folderPath = (name: string): string => name.trim().replace(/\/$/, "");

/** A file name that stands in for a folder's contents when its path is checked. */
const PROBE = "probe.md";

/**
 * Why the folder `name` (as {@link folderPath} reads it) can't be added next to the draft's `paths` and the folders
 * shown so far (`folders`); null when it can. Folders aren't stored (KOBE-478): a folder is the
 * prefix of its files' paths, so the check is that of a file inside it.
 */
export function newFolderProblem(
  name: string,
  paths: readonly string[],
  folders: readonly string[],
): string | null {
  const folder = folderPath(name);
  if (folder === "") return "Give the folder a name, such as templates.";
  if (paths.includes(folder)) return "A file has this name.";
  if (folders.includes(folder) || paths.some((p) => p.startsWith(`${folder}/`)))
    return "A folder already has this name.";
  const lower = folder.toLowerCase();
  const existing = [...folders, ...paths.flatMap(ancestors)];
  if (existing.some((f) => f.toLowerCase() === lower))
    return "Another folder has this name in a different case.";
  const probe = `${folder}/${PROBE}`;
  const problem = checkPackagePaths([...paths, probe]).find(
    (p) => p.problem !== "skill_md_missing" && p.path === probe,
  );
  return problem ? MESSAGES[problem.problem] : null;
}

/** The folders a path sits in: `a/b/c.md` is in `a` and `a/b`. */
function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
