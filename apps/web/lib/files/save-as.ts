/**
 * Save As in the file editor (KOBE-615): the path a new copy starts with and why a typed path
 * cannot take it. Pure; the dialog is `components/files/save-as.tsx`. The server checks again
 * (path rules, read-only areas) and never overwrites: a save without a base version creates the
 * file or answers 409 `version_conflict` when one is there.
 */
import { mentionPathIssue } from "@kobe/protocol";
import { isReadOnlyPath, parentPath } from "./format";
import { baseName, joinPath } from "./tree";

/** `notes.md` -> [`notes`, `.md`]; a leading dot is part of the stem (`.env` has no extension). */
function splitExt(name: string): readonly [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/**
 * Where Save As starts: beside the file as `<stem>-copy<ext>` when its folder takes writes, else
 * at the top of My files under its own name (a project file a reader cannot commit, a thread
 * upload).
 */
export function defaultSaveAsPath(path: string, checkedOut?: ReadonlySet<string>): string {
  const name = baseName(path);
  const folder = parentPath(path);
  if (isReadOnlyPath(path, checkedOut)) return name;
  const [stem, ext] = splitExt(name);
  return joinPath(folder, `${stem}-copy${ext}`);
}

/** Why `target` cannot be the new file's path, or null. */
export function saveAsProblem(
  target: string,
  current: string,
  checkedOut?: ReadonlySet<string>,
): string | null {
  const path = target.trim();
  if (path === "") return "Type a path, for example notes/copy.md.";
  if (path !== target) return "A path can't start or end with a space.";
  if (path.endsWith("/")) return "End the path with the file's name.";
  if (path === current) return "That is this file. Use Save, or choose another path.";
  if (path === ".kobe" || path.startsWith(".kobe/")) return "That folder is not available.";
  if (mentionPathIssue(path) !== undefined) {
    return "Use a path inside My files (no leading /, no empty, . or .. parts) without invisible or control characters, `, $ or ;.";
  }
  if (isReadOnlyPath(path, checkedOut)) {
    return "That folder is read-only (project files and thread uploads). Choose a folder in My files.";
  }
  return null;
}
