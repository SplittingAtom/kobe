import { extensionOf } from "./files.js";
import type { ScanFile } from "./types.js";

/**
 * Which text files get the script rules (KOBE-312 review S2). A file is a script by its extension
 * (invisible characters ignored), a shebang, having no extension at all, living under `scripts/`
 * (the skill layout's place for executables), or because another file of the bundle runs it,
 * directly or as an interpreter's input or source (`bash x.txt`, `python3 < x.txt`,
 * `cat x.txt | sh`, `source x.txt`, `./tool`): a skill can tell the model to run any file,
 * whatever it is named.
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

/**
 * A line that runs something: an interpreter or shell builtin that executes a file or its input
 * (`python3 < f`, `cat f | node`, `bash -c "$(cat f)"`, `source f`, `. f`, `exec(open(f))`).
 * Linear: alternations of words, no nested quantifiers.
 */
const RUNS = new RegExp(
  [
    String.raw`\b(?:(?:ba|z|da|k)?sh|python[23]?(?:\.\d{1,2})?|node|deno|bun|ruby|perl|php|pwsh|powershell|exec|execfile|eval|runpy|run_path|subprocess)\b`,
    String.raw`\b(?:system|spawn|popen)\s*\(`,
    // `source f` and `. f` only where a command starts (not "open source", not a sentence end).
    String.raw`(?:^|[;&|(\x60"'])[ \t]*(?:source|\.)[ \t]+[\w./~$"']`,
    String.raw`(?:^|[\s;&|(\x60"'])\.\/\w`,
  ].join("|"),
);
/** Path-shaped tokens on such a line. */
const PATH_TOKEN = /[\w.\-/]{1,256}/g;
const MAX_LINE_SCAN = 4096;
const MAX_REFERENCES = 1000;

const normalise = (p: string) => p.replace(/^(?:\.\/)+/, "");

/**
 * The bundle files that some text in the bundle runs, directly or as an interpreter's input: a
 * path of the bundle named on a line that runs something, as written, relative (`./x`), or under
 * an install directory (`/skills/demo/x`). Bounded: the first {@link MAX_LINE_SCAN} characters
 * of each line, at most {@link MAX_REFERENCES} hits.
 */
export function runReferences(texts: Iterable<string>, paths: readonly string[]): Set<string> {
  const known = new Set(paths);
  const found = new Set<string>();
  const match = (token: string) => {
    const t = normalise(token);
    if (known.has(t)) return t;
    // An absolute or prefixed path: any "/"-suffix of it that names a bundle file.
    for (let i = t.indexOf("/"); i >= 0; i = t.indexOf("/", i + 1)) {
      const tail = t.slice(i + 1);
      if (known.has(tail)) return tail;
    }
    return undefined;
  };
  for (const text of texts) {
    for (const full of text.split(/\r?\n/)) {
      const line = full.slice(0, MAX_LINE_SCAN);
      if (!RUNS.test(line)) continue;
      for (const [token] of line.matchAll(PATH_TOKEN)) {
        const hit = match(token);
        if (hit) found.add(hit);
        if (found.size >= MAX_REFERENCES) return found;
      }
    }
  }
  return found;
}

export function isScript(file: ScanFile, refs: ReadonlySet<string>): boolean {
  const ext = extensionOf(file.path);
  if (SCRIPT_EXTENSIONS.has(ext) || ext === "") return true;
  if (file.bytes[0] === 0x23 && file.bytes[1] === 0x21) return true; // "#!"
  if (file.path.startsWith("scripts/") || file.path.includes("/scripts/")) return true;
  return refs.has(file.path);
}
