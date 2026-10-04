import { parse } from "yaml";
import type { KeptFile } from "./bundle";
import { SKILL_LIMITS, SKILL_MD, SKILL_NAME } from "./limits";

export interface DraftFile {
  /** Stable identity for the row (paths are editable). */
  readonly key: number;
  readonly path: string;
  readonly text: string;
}
export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly other: string;
  readonly body: string;
  readonly files: readonly DraftFile[];
}
export interface SkillErrors {
  readonly name?: readonly string[];
  readonly description?: readonly string[];
  readonly other?: readonly string[];
  readonly body?: readonly string[];
  readonly files?: Readonly<Record<number, string>>;
  readonly form?: readonly string[];
}
export type SkillValidation =
  | { readonly ok: true; readonly problems: 0 }
  | {
      readonly ok: false;
      readonly problems: number;
      readonly errors: SkillErrors;
    };

const encoder = new TextEncoder();
const bytesOf = (s: string) => encoder.encode(s).length;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const MIB = 1024 * 1024;

const canon = (path: string) => path.normalize("NFC").toLowerCase();

/** What is wrong with a bundle path, in words; null when fine (mirrors the server's rules). */
export function pathProblem(path: string): string | null {
  if (path.trim() === "") return "Give the file a path, such as references/guide.md.";
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return "Use a relative path.";
  if (path.includes("\\")) return "Use / between folders, not \\.";
  if (CONTROL.test(path)) return "The path has control characters.";
  if (bytesOf(path) > SKILL_LIMITS.maxPathBytes)
    return `The path is longer than ${SKILL_LIMITS.maxPathBytes} bytes.`;
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === ".." || part === "__proto__")
      return "The path has an empty, . or .. folder name.";
  }
  if (canon(path) === canon(SKILL_MD)) return "SKILL.md is edited above, not as an extra file.";
  return null;
}

function frontmatterProblem(other: string): string | null {
  if (other.trim() === "") return null;
  let data: unknown;
  try {
    data = parse(other, { schema: "core", maxAliasCount: 10 });
  } catch {
    return "The other frontmatter is not valid YAML.";
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return "The other frontmatter must be key: value lines.";
  if ("name" in data || "description" in data)
    return "Set name and description in their own fields, not here.";
  return null;
}

export function validateSkill(draft: SkillDraft, kept: readonly KeptFile[]): SkillValidation {
  const L = SKILL_LIMITS;
  const name: string[] = [];
  const description: string[] = [];
  const other: string[] = [];
  const body: string[] = [];
  const form: string[] = [];
  const files: Record<number, string> = {};

  if (!SKILL_NAME.test(draft.name))
    name.push(
      "Use lowercase letters, digits and hyphens, up to 64 characters, such as report-writer.",
    );
  if (draft.description.trim() === "")
    description.push(`A description is required (up to ${L.descriptionMax} characters).`);
  else if (draft.description.length > L.descriptionMax)
    description.push(`The description is longer than ${L.descriptionMax} characters.`);
  const fm = frontmatterProblem(draft.other);
  if (fm) other.push(fm);
  else if (bytesOf(draft.other) > L.maxFrontmatterBytes)
    other.push("The frontmatter is longer than 16 KiB.");
  if (bytesOf(draft.body) + bytesOf(draft.description) + bytesOf(draft.other) > L.maxSkillMdBytes)
    body.push("SKILL.md is larger than 100 KiB.");

  const seen = new Map<string, number>(kept.map((k, i) => [canon(k.path), -1 - i]));
  let total = bytesOf(draft.body) + bytesOf(draft.description) + bytesOf(draft.other);
  for (const f of draft.files) {
    const problem = pathProblem(f.path);
    if (problem) files[f.key] = problem;
    else if (seen.has(canon(f.path))) files[f.key] = "Another file already has this path.";
    else seen.set(canon(f.path), f.key);
    const size = bytesOf(f.text);
    total += size;
    if (size > L.maxFileBytes) files[f.key] = files[f.key] ?? "This file is larger than 10 MiB.";
  }
  for (const k of kept) total += k.bytes.length;
  const count = 1 + draft.files.length + kept.length;
  if (count > L.maxFiles)
    form.push(`A skill can have at most ${L.maxFiles} files (this has ${count}).`);
  if (total > L.maxUncompressedBytes)
    form.push(`The files add up to ${(total / MIB).toFixed(1)} MiB; the limit is 25 MiB.`);

  const problems =
    name.length +
    description.length +
    other.length +
    body.length +
    form.length +
    Object.keys(files).length;
  if (problems === 0) return { ok: true, problems: 0 };
  const errors: SkillErrors = {
    ...(name.length ? { name } : {}),
    ...(description.length ? { description } : {}),
    ...(other.length ? { other } : {}),
    ...(body.length ? { body } : {}),
    ...(Object.keys(files).length ? { files } : {}),
    ...(form.length ? { form } : {}),
  };
  return { ok: false, problems, errors };
}
