/**
 * Workbench templates (KOBE-322, spec SK10 start 1): a starting SKILL.md (and a reference where it
 * helps) for five common kinds of skill. The author's name goes into the frontmatter; everything
 * else is theirs to rewrite. Plain data: no template pre-approves tools or carries scripts.
 */

export const TEMPLATE_IDS = [
  "document-generator",
  "data-analysis",
  "api-helper",
  "review-checklist",
  "house-style",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface Template {
  readonly id: TemplateId;
  readonly title: string;
  readonly summary: string;
  /** The description the draft starts with: what the skill does, then when to use it. */
  readonly description: string;
  readonly body: string;
  /** Other files, by package path. */
  readonly files?: Readonly<Record<string, string>>;
}

const TEMPLATES: readonly Template[] = [
  {
    id: "document-generator",
    title: "Document generator",
    summary: "Turns notes or data into a document with a fixed structure.",
    description:
      "Writes a structured document (report, brief or memo) from the user's notes or data, following the section outline in references/outline.md. Use when asked to draft, write up or produce that kind of document.",
    body: [
      "# Document generator",
      "",
      "1. Ask for the source material if it isn't in the conversation or the workspace.",
      "2. Follow the outline in [the outline](references/outline.md): every section, in order.",
      "3. Write plainly: short sentences, numbers with units, no filler.",
      "4. Save the result to `/workspace/out/` and say where it is.",
      "",
      "## Never",
      "",
      "- Invent figures or quotes that aren't in the source.",
    ].join("\n"),
    files: {
      "references/outline.md": [
        "# Outline",
        "",
        "1. Summary (three sentences)",
        "2. Background",
        "3. Findings",
        "4. Next steps, with owners and dates",
        "",
      ].join("\n"),
    },
  },
  {
    id: "data-analysis",
    title: "Data analysis",
    summary: "A repeatable analysis of a kind of file, with the checks and charts you want.",
    description:
      "Analyses the user's CSV or spreadsheet exports of a known shape: cleans them, runs the agreed checks and summarises the results with one chart. Use when the user shares such a file or asks for this analysis.",
    body: [
      "# Data analysis",
      "",
      "1. Load the file with pandas; report rows, columns and missing values first.",
      "2. Clean: describe each change you make (dropped rows, renamed columns).",
      "3. Run the checks the user cares about (list them here).",
      "4. One chart that answers the main question; save it to `/workspace/out/`.",
      "5. Close with three findings and any caveats.",
    ].join("\n"),
  },
  {
    id: "api-helper",
    title: "API helper",
    summary: "How to call one API well: endpoints, parameters, errors.",
    description:
      "Explains how to call one API correctly: which endpoint to use, required parameters, paging and error handling, as written down in references/api.md. Use when the user asks how to use that API or to write code against it.",
    body: [
      "# API helper",
      "",
      "Read [the API notes](references/api.md) before answering.",
      "",
      "- Name the endpoint and method, then a minimal working example.",
      "- Mention paging, rate limits and the errors the caller must handle.",
      "- Never put credentials in examples: use a placeholder such as `$API_TOKEN`.",
    ].join("\n"),
    files: {
      "references/api.md": [
        "# API notes",
        "",
        "Base URL, authentication, the main endpoints and their parameters go here.",
        "",
      ].join("\n"),
    },
  },
  {
    id: "review-checklist",
    title: "Review checklist",
    summary: "Checks a piece of work against your team's checklist.",
    description:
      "Reviews a document, change or plan against the team's checklist in references/checklist.md and reports each item as met, not met or not applicable. Use when asked to review, check or sign off that kind of work.",
    body: [
      "# Review checklist",
      "",
      "Go through every item in [the checklist](references/checklist.md), in order.",
      "",
      "For each: met, not met (with the reason and where) or not applicable.",
      "End with the not-met items as a short list to fix.",
    ].join("\n"),
    files: {
      "references/checklist.md": [
        "# Checklist",
        "",
        "- [ ] The goal is stated in one sentence",
        "- [ ] Risks and how to roll back are written down",
        "",
      ].join("\n"),
    },
  },
  {
    id: "house-style",
    title: "House style",
    summary: "Your team's writing rules, applied to anything the agent writes.",
    description:
      "Applies the team's house style (tone, spelling, terms and formatting rules in references/style.md) to text the agent writes or edits. Use when writing or editing anything meant for customers or colleagues, or when asked to check the style.",
    body: [
      "# House style",
      "",
      "Follow every rule in [the style guide](references/style.md).",
      "",
      "When editing, change only what breaks a rule, and list the rules you applied.",
    ].join("\n"),
    files: {
      "references/style.md": [
        "# Style guide",
        "",
        "- Spelling: …",
        "- Tone: …",
        "- Terms we always (and never) use: …",
        "",
      ].join("\n"),
    },
  },
];

export function templates(): readonly Template[] {
  return TEMPLATES;
}

/** The files of a draft started from `id` under `name` (a valid skill name). */
export function templateFiles(id: TemplateId, name: string): Map<string, Uint8Array> {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`unknown template ${id}`);
  const encode = (s: string) => new TextEncoder().encode(s);
  const skillMd = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(t.description)}`,
    "---",
    "",
    t.body,
    "",
  ].join("\n");
  return new Map([
    ["SKILL.md", encode(skillMd)],
    ...Object.entries(t.files ?? {}).map(([p, text]) => [p, encode(text)] as const),
  ]);
}
