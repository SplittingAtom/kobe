import { ORIGIN_TOKEN, SECTIONS, type GuidePage, type GuideSection } from "./loader.js";

/**
 * The guide for agents (KOBE-616), per https://llmstxt.org: `/llms.txt` is the index (H1 app name,
 * a one-line summary, a short paragraph, then one `## <Section>` per section, "For agents" first,
 * with `- [Title](<origin>/docs/<slug>.md): summary`), `/llms-full.txt` is every page in one file,
 * and `/docs/<slug>.md` is one page. No team or user data: the guide only.
 *
 * Shared by the web routes and the server's docs tools (KOBE-620, `@kobe/guide`), so both answer
 * the same bytes for the same origin and app name.
 */

export interface LlmsContext {
  /** The site branding's app name ("Kobe" by default). */
  readonly appName: string;
  /** The public origin, no trailing slash. */
  readonly origin: string;
}

const AGENTS_FIRST: readonly string[] = [
  "For agents",
  ...SECTIONS.filter((s) => s !== "For agents"),
];

export function pageMarkdownUrl(page: GuidePage, origin: string): string {
  return `${origin}/docs/${page.slug}.md`;
}

function withOrigin(markdown: string, origin: string): string {
  return markdown.split(ORIGIN_TOKEN).join(origin);
}

/** Link text inside `[...]` with its brackets escaped. */
function linkText(text: string): string {
  return text.replace(/([[\]\\])/g, "\\$1");
}

export function llmsTxt(pages: readonly GuidePage[], ctx: LlmsContext): string {
  const lines = [
    `# ${ctx.appName}`,
    "",
    `> ${ctx.appName} is a self-hosted conversational agent platform: people in one organization and its teams chat with AI agents that work in isolated sandboxes.`,
    "",
    `This is the ${ctx.appName} user guide for agents and people. Each link below is one page as Markdown; ${ctx.origin}/llms-full.txt has every page in one file. The same pages are at ${ctx.origin}/docs for people.`,
  ];
  for (const section of AGENTS_FIRST) {
    const inSection = pages.filter((p) => p.section === section);
    if (inSection.length === 0) continue;
    lines.push("", `## ${section}`, "");
    for (const p of inSection)
      lines.push(`- [${linkText(p.title)}](${pageMarkdownUrl(p, ctx.origin)}): ${p.summary}`);
  }
  return lines.join("\n") + "\n";
}

/** One page: title as H1, the summary as a quote, the body with absolute links. */
export function pageMarkdown(page: GuidePage, origin: string): string {
  return `# ${page.title}\n\n> ${page.summary}\n\n${withOrigin(page.markdown, origin)}`;
}

/** Every page in one file; with `section`, only that section's pages (the docs_full tool). */
export function llmsFullTxt(
  pages: readonly GuidePage[],
  ctx: LlmsContext,
  section?: GuideSection,
): string {
  const ordered = AGENTS_FIRST.filter((s) => section === undefined || s === section).flatMap((s) =>
    pages.filter((p) => p.section === s),
  );
  const head = `# ${ctx.appName} user guide\n\n> Every page of the ${ctx.appName} guide in one file; the index is ${ctx.origin}/llms.txt.\n`;
  const parts = ordered.map(
    (p) =>
      `${pageMarkdown(p, ctx.origin).trimEnd()}\n\nSource: ${pageMarkdownUrl(p, ctx.origin)}\n`,
  );
  return [head, ...parts].join("\n---\n\n");
}
