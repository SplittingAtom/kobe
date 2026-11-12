import { headingSlug } from "./headings.js";
import type { GuidePage, GuideSection } from "./loader.js";

/**
 * Search over the guide for the `docs_search` tool (KOBE-620, spec kobe-admin-mcp §4): page titles,
 * summaries and h2–h4 headings, never the body. Every word of the query must match somewhere in
 * the page; a word found in the title ranks above one found in a heading, above the summary. Ties
 * keep nav order. Results are capped.
 */

export const SEARCH_MAX_RESULTS = 20;
/** Query words beyond this are ignored; each word is cut to this many characters. */
const MAX_WORDS = 12;
const MAX_WORD_LENGTH = 64;
/** Matching headings listed per result. */
const MAX_HEADINGS = 5;

export interface GuideHeading {
  readonly level: 2 | 3 | 4;
  readonly text: string;
  /** The anchor on the viewer page (`/docs/<slug>#<id>`), numbered like the viewer's. */
  readonly id: string;
}

export interface GuideSearchHit {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly section: GuideSection;
  /** The page as Markdown (what `docs_page` returns). */
  readonly url: string;
  readonly headings: readonly { readonly text: string; readonly url: string }[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{2,4})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** Inline Markdown reduced to its text (links, emphasis and code marks dropped). */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

/** The page's h2–h4 headings outside fenced code, in order. */
export function pageHeadings(page: GuidePage): GuideHeading[] {
  const out: GuideHeading[] = [];
  const used = new Map<string, number>();
  let fence: string | null = null;
  for (const line of page.markdown.split("\n")) {
    const f = FENCE.exec(line);
    if (fence !== null) {
      if (f && f[1]?.[0] === fence[0] && (f[1]?.length ?? 0) >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1] ?? "```";
      continue;
    }
    const m = HEADING.exec(line);
    if (!m) continue;
    const text = plain(m[2] ?? "");
    const base = headingSlug(text) || "section";
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    out.push({
      level: (m[1]?.length ?? 2) as 2 | 3 | 4,
      text,
      id: n === 0 ? base : `${base}-${n}`,
    });
  }
  return out;
}

function words(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "")
    .slice(0, MAX_WORDS)
    .map((w) => w.slice(0, MAX_WORD_LENGTH));
}

export function searchGuide(
  pages: readonly GuidePage[],
  query: string,
  origin: string,
  limit: number = SEARCH_MAX_RESULTS,
): GuideSearchHit[] {
  const terms = words(query);
  if (terms.length === 0) return [];
  const cap = Math.max(1, Math.min(Math.trunc(limit) || SEARCH_MAX_RESULTS, SEARCH_MAX_RESULTS));
  const scored: { hit: GuideSearchHit; score: number; index: number }[] = [];
  pages.forEach((page, index) => {
    const title = page.title.toLowerCase();
    const summary = page.summary.toLowerCase();
    const headings = pageHeadings(page);
    let score = 0;
    for (const term of terms) {
      const best = title.includes(term)
        ? 3
        : headings.some((h) => h.text.toLowerCase().includes(term))
          ? 2
          : summary.includes(term)
            ? 1
            : 0;
      if (best === 0) return;
      score += best;
    }
    const matching = headings
      .filter((h) => terms.some((t) => h.text.toLowerCase().includes(t)))
      .slice(0, MAX_HEADINGS)
      .map((h) => ({ text: h.text, url: `${origin}/docs/${page.slug}#${h.id}` }));
    scored.push({
      score,
      index,
      hit: {
        slug: page.slug,
        title: page.title,
        summary: page.summary,
        section: page.section,
        url: `${origin}/docs/${page.slug}.md`,
        headings: matching,
      },
    });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, cap)
    .map((s) => s.hit);
}
