import { extensionOf } from "./files.js";
import type { ScanFile } from "./types.js";

/**
 * Which text files get the script rules (KOBE-312 review S2). A file is a script by its extension
 * (invisible characters ignored), a shebang, having no extension at all, living under `scripts/`
 * (the skill layout's place for executables), or because another file
 * of the bundle runs it through an interpreter (`bash scripts/setup.txt`, `./tool`): a skill can
 * tell the model to run any file, whatever it is named.
 */
const SCRIPT_EXTENSIONS = new Set([
  "sh",
  "bash",
  "zsh",
  "ksh",
  "py",
  "js",
  "mjs",
  "cjs",
  "ts",
  "rb",
  "pl",
  "php",
  "ps1",
  "bat",
  "cmd",
]);

const INTERPRETER = String.raw`(?:(?:ba|z|da|k)?sh|python[23]?(?:\.\d{1,2})?|node|deno|bun|ruby|perl|php|pwsh|powershell|source|exec|\.)`;
/** `<interpreter> [-flags] path` or `./path`; the path is captured. Linear: disjoint classes. */
const RUN_REFERENCE = new RegExp(
  String.raw`(?:^|[\s;&|(\x60"'])(?:${INTERPRETER}[ \t]+(?:-[\w-]{1,20}[ \t]+){0,4}["']?|\.\/)((?:\.{0,2}\/)?[\w.\-/]{1,256})`,
  "gm",
);
const MAX_REFERENCES = 1000;

const normalise = (p: string) => p.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "");

/** Paths that some text in the bundle runs through an interpreter (bounded). */
export function runReferences(texts: Iterable<string>): Set<string> {
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(RUN_REFERENCE)) {
      if (found.size >= MAX_REFERENCES) return found;
      if (m[1]) found.add(normalise(m[1]));
    }
  }
  return found;
}

function referenced(path: string, refs: ReadonlySet<string>): boolean {
  if (refs.has(path)) return true;
  for (const r of refs) if (r.endsWith("/" + path) || path.endsWith("/" + r)) return true;
  return false;
}

export function isScript(file: ScanFile, refs: ReadonlySet<string>): boolean {
  const ext = extensionOf(file.path);
  if (SCRIPT_EXTENSIONS.has(ext) || ext === "") return true;
  if (file.bytes[0] === 0x23 && file.bytes[1] === 0x21) return true; // "#!"
  if (file.path.startsWith("scripts/") || file.path.includes("/scripts/")) return true;
  return referenced(file.path, refs);
}
