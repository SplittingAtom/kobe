import { parse } from "yaml";
import { parseSemver } from "../semver.js";
import { manifestWithoutNumber } from "./manifest-sync.js";

/**
 * The suggested semver bump of a Save version (KOBE-321, spec SK14): patch for references, assets
 * and other files (`evals/`, `kobe.skill.yaml` included), minor for an edit of SKILL.md's
 * instructions or its other frontmatter, major for a change of the name, the description or any
 * script. The author decides; this only advises. Files are compared byte for byte.
 */

export type BumpKind = "major" | "minor" | "patch";

export interface BumpAdvice {
  /** Null when nothing changed (a save would be refused as unchanged). */
  readonly kind: BumpKind | null;
  readonly reasons: readonly string[];
}

const SKILL_MD = "SKILL.md";
const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** Script extensions the scanner also treats as scripts (outside `scripts/`). */
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|php|lua)$/i;
const MAX_LISTED = 5;
const PART_MAX = 999_999_999;

interface SkillMdParts {
  readonly name: unknown;
  readonly description: unknown;
  readonly rest: string;
  readonly body: string;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function partsOf(bytes: Uint8Array | undefined): SkillMdParts | null {
  if (!bytes) return null;
  const text = decoder.decode(bytes).replace(/^\uFEFF/, "");
  const match = FENCE.exec(text);
  if (!match?.[1]) return null;
  let data: unknown;
  try {
    data = parse(match[1], { schema: "core", maxAliasCount: 10 });
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const { name, description, ...rest } = data as Record<string, unknown>;
  return { name, description, rest: JSON.stringify(rest), body: text.slice(match[0].length) };
}

const same = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b));

/** Same file; for kobe.skill.yaml, the same apart from the number and changelog a save writes. */
function sameFile(path: string, a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (same(a, b)) return true;
  if (path !== "kobe.skill.yaml" || !a || !b) return false;
  const x = manifestWithoutNumber(a);
  return x !== null && x === manifestWithoutNumber(b);
}

const listed = (paths: readonly string[]): string =>
  paths.length <= MAX_LISTED
    ? paths.join(", ")
    : `${paths.slice(0, MAX_LISTED).join(", ")} and ${paths.length - MAX_LISTED} more`;

const isScript = (path: string): boolean => path.startsWith("scripts/") || SCRIPT_EXT.test(path);

function skillMdReasons(
  before: Uint8Array | undefined,
  after: Uint8Array | undefined,
): { major: string[]; minor: string[] } {
  if (same(before, after) || (!before && !after)) return { major: [], minor: [] };
  const a = partsOf(before);
  const b = partsOf(after);
  // An unreadable SKILL.md on either side: its name and description can't be compared, so major.
  if (!a || !b) return { major: ["the name or description changed"], minor: [] };
  const major = [
    ...(a.name !== b.name ? ["the name changed"] : []),
    ...(a.description !== b.description ? ["the description changed"] : []),
  ];
  const minor = a.body !== b.body || a.rest !== b.rest ? ["SKILL.md instructions changed"] : [];
  return { major, minor };
}

export function adviseBump(
  before: ReadonlyMap<string, Uint8Array>,
  after: ReadonlyMap<string, Uint8Array>,
): BumpAdvice {
  const paths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((p) => p !== SKILL_MD && !sameFile(p, before.get(p), after.get(p)))
    .sort();
  const md = skillMdReasons(before.get(SKILL_MD), after.get(SKILL_MD));
  const scripts = paths.filter(isScript);
  const others = paths.filter((p) => !isScript(p));
  const major = [
    ...md.major,
    ...(scripts.length > 0 ? [`scripts changed: ${listed(scripts)}`] : []),
  ];
  const reasons = [
    ...major,
    ...md.minor,
    ...(others.length > 0 ? [`other files changed: ${listed(others)}`] : []),
  ];
  const kind: BumpKind | null =
    major.length > 0 ? "major" : md.minor.length > 0 ? "minor" : others.length > 0 ? "patch" : null;
  return { kind, reasons };
}

/** The next number after `latest` for a bump of `kind`; null when it would leave the range. */
export function bumpSemver(latest: string, kind: BumpKind): string | null {
  const v = parseSemver(latest);
  if (!v) return null;
  const next =
    kind === "major"
      ? { major: v.major + 1, minor: 0, patch: 0 }
      : kind === "minor"
        ? { major: v.major, minor: v.minor + 1, patch: 0 }
        : { major: v.major, minor: v.minor, patch: v.patch + 1 };
  if (next.major > PART_MAX || next.minor > PART_MAX || next.patch > PART_MAX) return null;
  return `${next.major}.${next.minor}.${next.patch}`;
}
