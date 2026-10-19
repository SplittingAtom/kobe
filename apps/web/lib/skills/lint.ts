import { SKILL_NAME_PATTERN as SKILL_NAME } from "@kobe/protocol";
import { splitSkillMd } from "./skill-md";

/**
 * Workbench lint (KOBE-321, spec SK12), run on every edit in the browser: SKILL.md's name rules,
 * a description that says what the skill does and when to use it, referenced files that exist,
 * scripts that SKILL.md lists, no absolute paths into the package, and an `evals/` folder. Errors are what Save
 * version refuses; warnings are advice. The server stays the authority.
 */

export type LintLevel = "error" | "warning";

export interface LintItem {
  readonly id: string;
  readonly level: LintLevel;
  readonly message: string;
  /** The draft file the item is about, when there is one. */
  readonly file?: string;
}

export interface LintInput {
  readonly skillMd: string;
  /** Every path in the draft, SKILL.md included. */
  readonly paths: readonly string[];
  /** Files the scan preview treats as scripts (by extension or shebang), when known. */
  readonly scripts?: readonly string[];
}

/** "Use when …", "when the user …", "for questions about …": the description's trigger. */
const WHEN =
  /\b(when|whenever|if)\b|\buse (it |this( skill)? )?(for|to|on|with)\b|\bfor (tasks|requests|questions|work) (about|on|with|involving|that)\b/i;
/** Fewer words than this before "Use when" say too little about what the skill does. */
const WHAT_MIN_WORDS = 3;
const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
/** A skill-relative path to a file in the usual folders, not inside a longer absolute path. */
const FOLDER_PATH = /(?<![\w./~\\-])((?:scripts|references|assets|evals)\/[\w./-]*[\w-])/g;
/** An absolute path: `/a/b…`, `~/…` or a drive letter (not a URL: `://` is excluded). */
const ABSOLUTE =
  /(?<![\w.:/~\\-])(\/[\w.@-]+(?:\/[\w.@-]+)*|~\/[^\s)`'"<>]+|[A-Za-z]:\\[^\s)`'"<>]+)/g;
const PACKAGE_SEGMENT = /\/(?:scripts|references|assets|evals)\/|\/SKILL\.md$|\/kobe\.skill\.yaml$/;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

const item = (id: string, level: LintLevel, message: string, file?: string): LintItem => ({
  id,
  level,
  message,
  ...(file === undefined ? {} : { file }),
});

function nameItems(name: string): LintItem[] {
  if (!SKILL_NAME.test(name))
    return [
      item(
        "name",
        "error",
        "The name must be lowercase letters, digits and hyphens, up to 64 characters, such as report-writer.",
      ),
    ];
  if (name.includes("--"))
    return [
      item("name-hyphens", "warning", "Avoid two hyphens in a row: other tools refuse them."),
    ];
  return [];
}

function descriptionItems(description: string): LintItem[] {
  if (description.trim() === "")
    return [
      item("description", "error", "Add a description: what the skill does and when to use it."),
    ];
  const trigger = WHEN.exec(description);
  if (!trigger)
    return [
      item(
        "description-when",
        "warning",
        'Say when to use the skill (for example "Use when asked for a monthly report"): agents pick skills by their description.',
      ),
    ];
  const before = description.slice(0, trigger.index).trim().split(/\s+/).filter(Boolean);
  if (before.length < WHAT_MIN_WORDS)
    return [
      item(
        "description-what",
        "warning",
        "Start the description with what the skill does, then when to use it.",
      ),
    ];
  return [];
}

/** Paths SKILL.md's body refers to: link targets and skill-folder paths, without anchors. */
function referencedPaths(body: string): Set<string> {
  const found = new Set<string>();
  for (const m of body.matchAll(LINK)) {
    const target = m[1] ?? "";
    if (EXTERNAL.test(target) || target.startsWith("/")) continue;
    found.add(target);
  }
  for (const m of body.matchAll(FOLDER_PATH)) found.add(m[1] ?? "");
  const clean = (p: string) => {
    const bare = p.split(/[#?]/)[0] ?? "";
    try {
      return decodeURIComponent(bare).replace(/^(\.\/)+/, "");
    } catch {
      return bare.replace(/^(\.\/)+/, "");
    }
  };
  return new Set([...found].map(clean).filter((p) => p !== ""));
}

function referenceItems(body: string, paths: readonly string[]): LintItem[] {
  const existing = new Set(paths);
  const isFolder = (p: string) => {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    return paths.some((q) => q.startsWith(prefix));
  };
  return [...referencedPaths(body)]
    .filter((p) => !existing.has(p) && !isFolder(p))
    .sort()
    .map((p) =>
      item("missing-file", "warning", `SKILL.md refers to ${p}, which is not in the draft.`, p),
    );
}

function scriptItems(
  body: string,
  paths: readonly string[],
  scripts: readonly string[],
): LintItem[] {
  const all = [...new Set([...paths.filter((p) => p.startsWith("scripts/")), ...scripts])].sort();
  return all
    .filter((p) => !body.includes(p))
    .map((p) =>
      item(
        "unlisted-script",
        "warning",
        `SKILL.md doesn't mention ${p}: say what it does and when to run it.`,
        p,
      ),
    );
}

/**
 * Absolute paths into the package (coordinator, KOBE-321): a path ending in one of the draft's
 * files or naming a skill folder. Others (`/workspace/out/…`, the sandbox's output) are fine.
 */
function absoluteItems(body: string, paths: readonly string[]): LintItem[] {
  const intoPackage = (raw: string) => {
    const p = raw.replaceAll("\\", "/").split(/[#?]/)[0] ?? "";
    return PACKAGE_SEGMENT.test(p) || paths.some((f) => p.endsWith(`/${f}`));
  };
  const found = [
    ...[...body.matchAll(LINK)].map((m) => m[1] ?? "").filter((t) => /^\/(?!\/)/.test(t)),
    ...[...body.matchAll(ABSOLUTE)].map((m) => m[1] ?? ""),
  ].filter(intoPackage);
  const ordered = [...new Set(found)].sort((a, b) => body.indexOf(a) - body.indexOf(b));
  return ordered.map((p) =>
    item(
      "absolute-path",
      "warning",
      `${p} is an absolute path into the skill: refer to its files relative to its folder, such as scripts/build.py.`,
    ),
  );
}

export function lintSkill(input: LintInput): readonly LintItem[] {
  const parts = splitSkillMd(input.skillMd);
  const evals = input.paths.some((p) => p.startsWith("evals/"))
    ? []
    : [
        item(
          "evals",
          "warning",
          "Add evals/cases.yaml with test prompts, so the skill can be evaluated.",
        ),
      ];
  if (!parts.ok) return [item("frontmatter", "error", parts.error, "SKILL.md"), ...evals];
  const { name, description, body } = parts.value;
  return [
    ...nameItems(name),
    ...descriptionItems(description),
    ...referenceItems(body, input.paths),
    ...scriptItems(body, input.paths, input.scripts ?? []),
    ...absoluteItems(body, input.paths),
    ...evals,
  ];
}
