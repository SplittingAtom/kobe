import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { parse, stringify } from "yaml";
import { SKILL_LIMITS, SKILL_MD } from "./limits";

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface TextFile {
  readonly path: string;
  readonly text: string;
}
export interface KeptFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}
export interface SkillMdParts {
  readonly name: string;
  readonly description: string;
  /** Every other frontmatter key, as YAML text (empty when there are none). */
  readonly other: string;
  readonly body: string;
}
export interface DecodedBundle {
  readonly skillMd: string;
  readonly text: readonly TextFile[];
  /** Files that are not UTF-8 text: shown read-only and carried unchanged into the next version. */
  readonly kept: readonly KeptFile[];
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Splits SKILL.md into its name, description, remaining frontmatter and body. */
export function splitSkillMd(text: string): Result<SkillMdParts> {
  const clean = text.replace(/^\uFEFF/, "");
  const match = FENCE.exec(clean);
  if (!match?.[1])
    return fail("SKILL.md must start with a YAML frontmatter block between --- lines.");
  let data: unknown;
  try {
    data = parse(match[1], { schema: "core", maxAliasCount: 10 });
  } catch {
    return fail("The SKILL.md frontmatter is not valid YAML.");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return fail("The SKILL.md frontmatter must be a mapping with name and description.");
  const { name, description, ...rest } = data as Record<string, unknown>;
  return {
    ok: true,
    value: {
      name: typeof name === "string" ? name : "",
      description: typeof description === "string" ? description : "",
      other: Object.keys(rest).length > 0 ? stringify(rest) : "",
      body: clean.slice(match[0].length),
    },
  };
}

/** Writes SKILL.md from its parts: name and description first, then the other keys. */
export function composeSkillMd(parts: SkillMdParts): string {
  const head = stringify({ name: parts.name, description: parts.description });
  return `---\n${head}${parts.other.trim() === "" ? "" : `${parts.other.trimEnd()}\n`}---\n${parts.body}`;
}

/** Zips SKILL.md, the text files and the kept binaries (the server repacks it canonically). */
export function buildZip(
  skillMd: string,
  text: readonly TextFile[],
  kept: readonly KeptFile[],
): Uint8Array {
  const entries: Record<string, Uint8Array> = { [SKILL_MD]: strToU8(skillMd) };
  for (const f of text) entries[f.path] = strToU8(f.text);
  for (const f of kept) entries[f.path] = f.bytes;
  return zipSync(entries);
}

const isText = (bytes: Uint8Array): string | null => {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** Opens a stored bundle under the upload caps (declared sizes are checked before inflating). */
export function decodeBundle(zip: Uint8Array): Result<DecodedBundle> {
  const { maxFiles, maxFileBytes, maxUncompressedBytes } = SKILL_LIMITS;
  let count = 0;
  let total = 0;
  let refused: string | null = null;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip, {
      filter: (file) => {
        if (refused) return false;
        count += 1;
        total += file.originalSize;
        if (count > maxFiles) refused = `The skill has more than ${maxFiles} files.`;
        else if (file.originalSize > maxFileBytes)
          refused = `${file.name} is larger than ${maxFileBytes / 1024 / 1024} MiB.`;
        else if (total > maxUncompressedBytes)
          refused = `The skill is larger than ${maxUncompressedBytes / 1024 / 1024} MiB unpacked.`;
        return refused === null && !file.name.endsWith("/");
      },
    });
  } catch {
    return fail("The stored bundle could not be read.");
  }
  if (refused) return fail(refused);
  const skill = files[SKILL_MD];
  if (!skill) return fail("The stored bundle has no SKILL.md.");
  const text: TextFile[] = [];
  const kept: KeptFile[] = [];
  for (const path of Object.keys(files).sort()) {
    if (path === SKILL_MD) continue;
    const bytes = files[path] as Uint8Array;
    const decoded = isText(bytes);
    if (decoded === null) kept.push({ path, bytes });
    else text.push({ path, text: decoded });
  }
  return { ok: true, value: { skillMd: strFromU8(skill), text, kept } };
}
