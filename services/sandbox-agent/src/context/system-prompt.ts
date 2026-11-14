import type { ContextSectionKind } from "@kobe/protocol";
import { MEMORY_HEADER } from "../memory/context.js";
import { PROJECT_HEADER } from "../memory/project-context.js";
import { VIEWING_HEADER } from "../memory/viewing-context.js";
import { CONFLICTS_HEADER } from "../memory/conflict-context.js";
import { KNOWN_HEADER, PICKS_HEADER, type SemanticSection } from "../memory/semantic-context.js";

/**
 * The system prompt of a model call, split into the context viewer's sections (KOBE-470, CV3).
 * Pi 1.0.0 builds it from named sections (`core/system-prompt.js`): `preamble`, `tools`, `rules`,
 * `docs` (Pi's own text), `addendum` (Kobe's `--append-system-prompt` file: the agent's
 * instructions), `project_context` (context files), `skills`, `cwd`, each but the preamble wrapped
 * in `<name>…</name>` and joined with blank lines. When kobe-tools adds the run's memory, project
 * instructions or viewed file (`before_agent_start` returning `systemPrompt`), Pi sends the whole
 * rendered prompt as one forced text instead, so it is split back here: exactly, from the parts
 * the agent wrote for the run, or by their headers when those no longer match.
 */
export interface RawSection {
  readonly kind: ContextSectionKind;
  readonly label: string;
  readonly text: string;
  /** Images in it (each counted as Pi's estimate of an image, not by its text). */
  readonly images?: number;
}

/** The per-run parts kobe-tools appended to the prompt, as the agent last wrote them. */
export interface KobePromptParts {
  readonly memory: string;
  readonly project: string;
  readonly viewing: string;
  /** Sync conflicts told at the run's start (KOBE-492); optional for older parts. */
  readonly conflicts?: string;
  /** What Kobe knows (KOBE-383): the stable part and the per-message picks, with their lanes. */
  readonly known?: string;
  readonly picks?: string;
  readonly knownSections?: readonly SemanticSection[];
  readonly picksSections?: readonly SemanticSection[];
}

const SECTION_KINDS: Readonly<Record<string, ContextSectionKind>> = {
  preamble: "system_prompt",
  tools: "system_prompt",
  rules: "system_prompt",
  docs: "system_prompt",
  cwd: "system_prompt",
  addendum: "agent_instructions",
  project_context: "agent_instructions",
  skills: "skills",
};

const SECTION_LABELS: Readonly<Record<string, string>> = {
  preamble: "Pi's prompt",
  tools: "Tool guidance",
  rules: "Rules",
  docs: "Pi documentation",
  cwd: "Working directory",
  addendum: "Agent instructions",
  project_context: "Context files",
  skills: "Skills",
};

export const kindOfSection = (name: string): ContextSectionKind => SECTION_KINDS[name] ?? "other";
export const labelOfSection = (name: string): string => SECTION_LABELS[name] ?? name;

const OPEN_TAG = /\n\n<([a-z][a-z0-9_-]*)>\n/g;

/**
 * Pi's rendered prompt back into its sections: the preamble, then `<name>\n…\n</name>` blocks
 * separated by blank lines. Whatever does not parse stays one `system_prompt` section.
 */
export function splitRenderedPrompt(text: string): RawSection[] {
  const out: RawSection[] = [];
  OPEN_TAG.lastIndex = 0;
  const first = OPEN_TAG.exec(text);
  if (first === null) return text === "" ? [] : [section("preamble", text)];
  const preamble = text.slice(0, first.index);
  if (preamble !== "") out.push(section("preamble", preamble));
  let cursor = first.index;
  while (cursor < text.length) {
    const open = /^\n\n<([a-z][a-z0-9_-]*)>\n/.exec(text.slice(cursor));
    const name = open?.[1];
    const close = name === undefined ? -1 : text.indexOf(`\n</${name}>`, cursor);
    if (open === null || name === undefined || close < 0) {
      out.push({ kind: "system_prompt", label: "Pi's prompt", text: text.slice(cursor) });
      return out;
    }
    const end = close + `\n</${name}>`.length;
    out.push(section(name, text.slice(cursor + 2, end)));
    cursor = end;
  }
  return out;
}

function section(name: string, text: string): RawSection {
  return { kind: kindOfSection(name), label: labelOfSection(name), text };
}

type TextPart = "memory" | "project" | "viewing" | "conflicts" | "known" | "picks";

/** kobe-tools' parts in the order it appends them (kobe-tools/memory-hooks.ts, KOBE-383). */
const KOBE_SECTIONS: readonly {
  readonly part: TextPart;
  readonly header: string;
  readonly kind: ContextSectionKind;
  readonly label: string;
  /** The part's own sections (What Kobe knows: one per lane), when the agent wrote them. */
  readonly sections?: "knownSections" | "picksSections";
}[] = [
  {
    part: "known",
    header: KNOWN_HEADER,
    kind: "memory",
    label: "What Kobe knows",
    sections: "knownSections",
  },
  { part: "memory", header: MEMORY_HEADER, kind: "memory", label: "Saved memory" },
  {
    part: "project",
    header: PROJECT_HEADER,
    kind: "agent_instructions",
    label: "Project instructions",
  },
  {
    part: "picks",
    header: PICKS_HEADER,
    kind: "memory",
    label: "What Kobe knows for this message",
    sections: "picksSections",
  },
  { part: "viewing", header: VIEWING_HEADER, kind: "viewing_file", label: "Viewed file" },
  {
    part: "conflicts",
    header: CONFLICTS_HEADER,
    kind: "system_prompt",
    label: "Workspace sync conflicts",
  },
];

function partSections(s: (typeof KOBE_SECTIONS)[number], parts: KobePromptParts): RawSection[] {
  const text = parts[s.part] ?? "";
  const own = s.sections === undefined ? undefined : parts[s.sections];
  // Lane sections only when they still add up to the part (joined by "\n", semantic-context.ts).
  if (own !== undefined && own.length > 0 && own.map((o) => o.text).join("\n") === text) {
    return own.map((o) => ({ kind: s.kind, label: o.label, text: o.text }));
  }
  return [{ kind: s.kind, label: s.label, text }];
}

/** A forced prompt: Pi's rendered prompt, then kobe-tools' parts (each after a blank line). */
export function splitForcedPrompt(text: string, parts: KobePromptParts | undefined): RawSection[] {
  if (parts !== undefined) {
    const present = KOBE_SECTIONS.filter((s) => (parts[s.part] ?? "") !== "");
    const suffix = present.map((s) => `\n\n${parts[s.part] ?? ""}`).join("");
    if (present.length > 0 && text.endsWith(suffix)) {
      return [
        ...splitRenderedPrompt(text.slice(0, text.length - suffix.length)),
        ...present.flatMap((s) => partSections(s, parts)),
      ];
    }
  }
  // The run's parts changed since (or are unknown): find them by their headers, in their order.
  const found: { start: number; kind: ContextSectionKind; label: string }[] = [];
  let from = 0;
  for (const s of KOBE_SECTIONS) {
    const at = text.indexOf(`\n\n${s.header}\n`, from);
    if (at < 0) continue;
    found.push({ start: at, kind: s.kind, label: s.label });
    from = at + 2;
  }
  if (found.length === 0) return splitRenderedPrompt(text);
  const out = splitRenderedPrompt(text.slice(0, found[0]?.start));
  found.forEach((f, i) => {
    const end = found[i + 1]?.start ?? text.length;
    out.push({ kind: f.kind, label: f.label, text: text.slice(f.start + 2, end) });
  });
  return out;
}
