import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * The Kobe guide's build step (KOBE-616): `docs/guide/<slug>.md` pages (YAML frontmatter, then
 * Markdown) become typed pages that `scripts/generate-guide.mjs` writes into the web bundle as
 * `guide.generated.ts`. Nothing is read from outside the app at runtime.
 *
 * Self-contained on purpose (only `yaml` and `zod`): Node runs this file directly from the
 * generator (type stripping), which cannot resolve extensionless relative imports. Client
 * components import its types only.
 *
 * Contract with the content (shared with KOBE-617): frontmatter `title`, `summary` (one sentence)
 * and `section` (one of SECTIONS) are required, `order` sorts within the section, `audience` is
 * member (default), admin or agent. Links between pages are relative links to the `.md` files;
 * the viewer gets `/docs/<slug>` and the Markdown outputs `<origin>/docs/<slug>.md`. A page with
 * missing or wrong frontmatter, an unknown section, a duplicate slug or a broken relative link
 * fails the build with every problem listed.
 */

/** The guide's sections, in nav order. */
export const SECTIONS = [
  "Getting started",
  "Chat and threads",
  "Files and editing",
  "Agents and skills",
  "Connectors and apps",
  "Memory",
  "Internet access and approvals",
  "Models",
  "Appearance",
  "Team admin",
  "Site admin",
  "Reference",
  "For agents",
] as const;
export type GuideSection = (typeof SECTIONS)[number];

export const AUDIENCES = ["member", "admin", "agent"] as const;
export type GuideAudience = (typeof AUDIENCES)[number];

/** Stands for the public origin in `markdown`; the routes replace it per request. */
export const ORIGIN_TOKEN = "%%KOBE_ORIGIN%%";

/** Pages without an `order` sort after the numbered ones (then by title). */
const DEFAULT_ORDER = 1000;

export interface GuidePage {
  /** The path under docs/guide without `.md`, e.g. `admin/team-settings`. */
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly section: GuideSection;
  readonly order: number;
  readonly audience: GuideAudience;
  /** For the viewer: frontmatter and leading H1 dropped, page links as `/docs/<slug>`. */
  readonly body: string;
  /** For the Markdown outputs: as `body`, page links as `${ORIGIN_TOKEN}/docs/<slug>.md`. */
  readonly markdown: string;
}

export interface GuideFile {
  /** Relative to docs/guide, `/`-separated, e.g. `chat/threads.md`. */
  readonly path: string;
  readonly content: string;
}

export class GuideBuildError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`The guide (docs/guide) has ${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
    this.name = "GuideBuildError";
    this.problems = problems;
  }
}

const frontmatterSchema = z.object({
  title: z.string().trim().min(1, "title must not be empty"),
  summary: z.string().trim().min(1, "summary must not be empty"),
  section: z.enum(SECTIONS, {
    error: (issue) =>
      issue.input === undefined
        ? "section is required"
        : `unknown section ${JSON.stringify(issue.input)} (one of: ${SECTIONS.join(", ")})`,
  }),
  order: z.number().finite().optional(),
  audience: z.enum(AUDIENCES).default("member"),
});

const SLUG_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** `chat/threads.md` → `chat/threads`; null when the path is not a lowercase `.md` page path. */
export function slugFromPath(path: string): string | null {
  if (!path.endsWith(".md")) return null;
  const slug = path.slice(0, -".md".length);
  return slug.split("/").every((s) => SLUG_SEGMENT.test(s)) ? slug : null;
}

/** Splits `---\n<yaml>\n---\n<body>`; throws when the frontmatter is missing or not YAML. */
export function splitFrontmatter(content: string): { data: unknown; body: string } {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!match) throw new Error("missing YAML frontmatter (the file must start with ---)");
  let data: unknown;
  try {
    data = parseYaml(match[1] ?? "");
  } catch (e) {
    throw new Error(`frontmatter is not valid YAML: ${(e as Error).message.split("\n")[0]}`, {
      cause: e,
    });
  }
  return { data, body: text.slice(match[0].length) };
}

/** Drops a leading `# Title` line: the viewer and the Markdown outputs print the title. */
function dropLeadingH1(body: string): string {
  return body.replace(/^\s*# [^\n]*\n?/, "").replace(/^\n+/, "");
}

function normalize(segments: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const s of segments) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(s);
  }
  return out;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

type Target = { viewer: string; markdown: string } | { error: string } | null;

/** How one link target is written in each output; null leaves it as it is. */
function resolveTarget(raw: string, fromSlug: string, slugs: ReadonlySet<string>): Target {
  const target = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
  if (target === "" || target.startsWith("#") || SCHEME.test(target) || target.startsWith("//"))
    return null;
  if (target.startsWith("/")) {
    if (target === "/docs" || target.startsWith("/docs/"))
      return { error: `link ${target}: link to the page's .md file with a relative path` };
    return { viewer: target, markdown: `${ORIGIN_TOKEN}${target}` };
  }
  const hashAt = target.indexOf("#");
  const path = hashAt === -1 ? target : target.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : target.slice(hashAt);
  if (!path.endsWith(".md"))
    return { error: `link ${target}: relative links must point at a guide page's .md file` };
  const dir = fromSlug.split("/").slice(0, -1);
  const resolved = normalize([...dir, ...path.split("/")]);
  const slug = resolved === null ? null : resolved.join("/").slice(0, -".md".length);
  if (slug === null || !slugs.has(slug))
    return {
      error:
        slug === null
          ? `broken link ${target}: it leaves docs/guide`
          : `broken link ${target}: no page docs/guide/${slug}.md`,
    };
  return { viewer: `/docs/${slug}${hash}`, markdown: `${ORIGIN_TOKEN}/docs/${slug}.md${hash}` };
}

const INLINE_LINK = /(\]\()(<[^>\n]*>|[^)\s]*)((?:\s+(?:"[^"]*"|'[^']*'))?\))/g;
const REFERENCE_DEF = /^( {0,3}\[[^\]]+\]:[ \t]*)(<[^>]*>|\S+)(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN = /(`+)[\s\S]*?\1/g;

/**
 * Rewrites the page links of one page's Markdown for both outputs (inline links and reference
 * definitions; never inside fenced code or code spans). Problems are returned, not thrown.
 */
export function rewriteLinks(
  markdown: string,
  fromSlug: string,
  slugs: ReadonlySet<string>,
): { body: string; markdown: string; problems: string[] } {
  const problems: string[] = [];
  const viewerLines: string[] = [];
  const mdLines: string[] = [];
  let fence: string | null = null;
  const rewrite = (text: string, mode: "viewer" | "markdown"): string => {
    const swap = (raw: string): string => {
      const t = resolveTarget(raw, fromSlug, slugs);
      if (t === null) return raw;
      if ("error" in t) {
        if (mode === "viewer") problems.push(t.error);
        return raw;
      }
      return t[mode];
    };
    const def = REFERENCE_DEF.exec(text);
    if (def) return `${def[1]}${swap(def[2] ?? "")}${def[3]}`;
    let out = "";
    let last = 0;
    for (const m of text.matchAll(CODE_SPAN)) {
      out += text.slice(last, m.index).replace(INLINE_LINK, (_, a, t, b) => a + swap(t) + b);
      out += m[0];
      last = m.index + m[0].length;
    }
    return out + text.slice(last).replace(INLINE_LINK, (_, a, t, b) => a + swap(t) + b);
  };
  for (const line of markdown.split("\n")) {
    const f = FENCE.exec(line);
    if (fence !== null) {
      if (f && f[1]?.[0] === fence[0] && (f[1]?.length ?? 0) >= fence.length) fence = null;
      viewerLines.push(line);
      mdLines.push(line);
      continue;
    }
    if (f) {
      fence = f[1] ?? "```";
      viewerLines.push(line);
      mdLines.push(line);
      continue;
    }
    viewerLines.push(rewrite(line, "viewer"));
    mdLines.push(rewrite(line, "markdown"));
  }
  return { body: viewerLines.join("\n"), markdown: mdLines.join("\n"), problems };
}

function compare(a: GuidePage, b: GuidePage): number {
  return (
    SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) ||
    a.order - b.order ||
    a.title.localeCompare(b.title) ||
    a.slug.localeCompare(b.slug)
  );
}

interface Parsed {
  readonly path: string;
  readonly slug: string;
  readonly data: z.infer<typeof frontmatterSchema>;
  readonly body: string;
}

function parseFile(file: GuideFile, problems: string[]): Parsed | null {
  const where = `docs/guide/${file.path}`;
  const slug = slugFromPath(file.path);
  if (slug === null) {
    problems.push(`${where}: file names must be lowercase a-z, 0-9 and - and end in .md`);
    return null;
  }
  let split: { data: unknown; body: string };
  try {
    split = splitFrontmatter(file.content);
  } catch (e) {
    problems.push(`${where}: ${(e as Error).message}`);
    return null;
  }
  const parsed = frontmatterSchema.safeParse(split.data ?? {});
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".");
      const missing = issue.code === "invalid_type" && issue.input === undefined;
      problems.push(`${where}: ${missing ? `${key} is required` : issue.message}`);
    }
    return null;
  }
  return { path: file.path, slug, data: parsed.data, body: dropLeadingH1(split.body) };
}

/** Every page, sorted by section, order and title; throws GuideBuildError listing all problems. */
export function buildGuide(files: readonly GuideFile[]): GuidePage[] {
  const problems: string[] = [];
  const parsed: Parsed[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const p = parseFile(file, problems);
    if (p === null) continue;
    const other = seen.get(p.slug);
    if (other !== undefined) {
      problems.push(`docs/guide/${p.path}: duplicate slug ${p.slug} (also docs/guide/${other})`);
      continue;
    }
    seen.set(p.slug, p.path);
    parsed.push(p);
  }
  const slugs = new Set(seen.keys());
  const pages = parsed.map((p): GuidePage => {
    const links = rewriteLinks(p.body, p.slug, slugs);
    for (const problem of links.problems) problems.push(`docs/guide/${p.path}: ${problem}`);
    return {
      slug: p.slug,
      title: p.data.title,
      summary: p.data.summary.replace(/\s+/g, " "),
      section: p.data.section,
      order: p.data.order ?? DEFAULT_ORDER,
      audience: p.data.audience,
      body: links.body.trimEnd() + "\n",
      markdown: links.markdown.trimEnd() + "\n",
    };
  });
  if (files.length === 0) problems.push("docs/guide has no pages");
  if (problems.length > 0) throw new GuideBuildError(problems);
  return pages.sort(compare);
}
