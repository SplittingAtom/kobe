import { z } from "zod";
import {
  llmsFullTxt,
  llmsTxt,
  PAGES,
  pageBySlug,
  pageMarkdown,
  searchGuide,
  SEARCH_MAX_RESULTS,
  SECTIONS,
  type GuidePage,
  type LlmsContext,
} from "@kobe/guide";
import { readAppName } from "../../branding/settings.js";
import type { KobeDb } from "@kobe/db";

/**
 * The docs tools of the built-in Kobe connector (KOBE-620, spec kobe-admin-mcp §4, KA4, KA7): the
 * user guide as the web serves it (`@kobe/guide`, the same pages and renderers as /llms.txt,
 * /llms-full.txt and /docs/<slug>.md), with the deployment's public origin and the site's app
 * name, so an agent in a sandbox reads the docs without any egress. Read-only, no team or user
 * data, no approval in any mode, and on every run whatever the agent's connector list.
 *
 * `docs_page` looks the slug up among the built pages; nothing is ever read from a path.
 */

export interface KobeDocsTool<I = unknown> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly readOnly: true;
  /** Strict: unknown keys are refused. */
  readonly input: z.ZodType<I>;
  /** Only tools with structured results declare one (the text tools return the guide's text). */
  readonly output?: z.ZodType;
  readonly run: (input: I, ctx: LlmsContext, pages: readonly GuidePage[]) => DocsAnswer;
}

type DocsAnswer =
  | { readonly text: string; readonly structured?: Record<string, unknown> }
  | { readonly code: string; readonly message: string };

/** What the model gets: an MCP `tools/call` result, or a tool error. */
export type KobeDocsExecution =
  | {
      readonly ok: true;
      readonly result: {
        readonly content: readonly { readonly type: "text"; readonly text: string }[];
        readonly structuredContent?: Record<string, unknown>;
      };
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The full text's cap: well inside a model's context; larger asks for one section. */
export const DOCS_FULL_MAX_BYTES = 256 * 1024;
const SLUG_MAX = 200;

const docsTool = <I>(tool: KobeDocsTool<I>): KobeDocsTool => tool as unknown as KobeDocsTool;

/** `admin/team-admin`, `admin/team-admin.md`, `/docs/admin/team-admin.md` or its full URL. */
function slugOf(raw: string, origin: string): string {
  let s = raw.trim();
  if (s.startsWith(origin)) s = s.slice(origin.length);
  if (s.startsWith("/docs/")) s = s.slice("/docs/".length);
  if (s.endsWith(".md")) s = s.slice(0, -".md".length);
  return s;
}

const docsIndex = docsTool({
  name: "docs_index",
  title: "Kobe guide: index",
  description:
    "The Kobe user guide's index (the site's /llms.txt): every page with its URL and a one-line " +
    "summary, grouped by section. Start here for any question about using or administering Kobe, " +
    "then read pages with docs_page.",
  readOnly: true,
  input: z.strictObject({}),
  run: (_input, ctx, pages) => ({ text: llmsTxt(pages, ctx) }),
});

const docsPage = docsTool({
  name: "docs_page",
  title: "Kobe guide: page",
  description:
    "One page of the Kobe user guide as Markdown (the site's /docs/<slug>.md). Pass the page's " +
    "slug from docs_index or docs_search, e.g. 'admin/team-admin' (its .md URL works too).",
  readOnly: true,
  input: z.strictObject({ slug: z.string().min(1).max(SLUG_MAX) }),
  run: (input: { slug: string }, ctx, pages) => {
    const page = pageBySlug(slugOf(input.slug, ctx.origin), pages);
    if (page === null) {
      return {
        code: "unknown_page",
        message: "No guide page has that slug. Use docs_index or docs_search to find the page.",
      };
    }
    return { text: pageMarkdown(page, ctx.origin) };
  },
});

const docsFull = docsTool({
  name: "docs_full",
  title: "Kobe guide: full text",
  description:
    "Every page of the Kobe user guide in one Markdown text (the site's /llms-full.txt), or only " +
    "one section's pages. Prefer docs_index plus docs_page; use this when you need much of it.",
  readOnly: true,
  input: z.strictObject({ section: z.enum(SECTIONS).optional() }),
  run: (input: { section?: (typeof SECTIONS)[number] | undefined }, ctx, pages) => {
    const text = llmsFullTxt(pages, ctx, input.section);
    if (Buffer.byteLength(text, "utf8") > DOCS_FULL_MAX_BYTES) {
      return {
        code: "too_large",
        message: `The full guide is too large for one result; pass a section (${SECTIONS.join(", ")}) or read pages with docs_page.`,
      };
    }
    return { text };
  },
});

const hit = z.strictObject({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  section: z.string(),
  url: z.string(),
  headings: z.array(z.strictObject({ text: z.string(), url: z.string() })),
});

const docsSearch = docsTool({
  name: "docs_search",
  title: "Kobe guide: search",
  description:
    "Searches the Kobe user guide's page titles, summaries and headings (every word must match). " +
    "Returns ranked pages with their slugs and URLs; read one with docs_page.",
  readOnly: true,
  input: z.strictObject({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(SEARCH_MAX_RESULTS).optional(),
  }),
  output: z.strictObject({ results: z.array(hit).max(SEARCH_MAX_RESULTS) }),
  run: (input: { query: string; limit?: number | undefined }, ctx, pages) => {
    const results = searchGuide(pages, input.query, ctx.origin, input.limit);
    const structured = { results };
    return { text: JSON.stringify(structured), structured };
  },
});

/** Every docs tool (KA7: on every run of every agent while the site switch is not `off`). */
export const KOBE_DOCS_TOOLS: readonly KobeDocsTool[] = [docsIndex, docsPage, docsFull, docsSearch];

export function kobeDocsToolByName(name: string): KobeDocsTool | undefined {
  return KOBE_DOCS_TOOLS.find((t) => t.name === name);
}

export const isKobeDocsToolName = (name: string): boolean => kobeDocsToolByName(name) !== undefined;

/** Runs one docs tool; invalid input and unknown pages are tool errors, never throws. */
export function runKobeDocsTool(
  tool: KobeDocsTool,
  input: unknown,
  ctx: LlmsContext,
  pages: readonly GuidePage[] = PAGES,
): KobeDocsExecution {
  const parsed = tool.input.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, code: "invalid_input", message: `The input of ${tool.name} is not valid.` };
  }
  const answer = tool.run(parsed.data, ctx, pages);
  if ("code" in answer) return { ok: false, code: answer.code, message: answer.message };
  return {
    ok: true,
    result: {
      content: [{ type: "text", text: answer.text }],
      ...(answer.structured === undefined ? {} : { structuredContent: answer.structured }),
    },
  };
}

/** The deployment's public origin and the site's app name: what /llms.txt is rendered with. */
export async function kobeDocsContext(db: KobeDb, publicUrl: string): Promise<LlmsContext> {
  return { appName: await readAppName(db), origin: new URL(publicUrl).origin };
}
