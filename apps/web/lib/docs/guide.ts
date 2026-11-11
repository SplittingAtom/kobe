import { GUIDE_PAGES } from "./guide.generated";
import { SECTIONS, type GuidePage, type GuideSection } from "./guide-loader";

/**
 * The guide built into the bundle (KOBE-616, lib/docs/guide.generated.ts) and the lookups the
 * /docs pages and the Markdown routes share. Pages come sorted by section, order and title.
 */
export const PAGES: readonly GuidePage[] = GUIDE_PAGES;

export interface GuideSectionGroup {
  readonly section: GuideSection;
  /** The nav anchor on the docs home, e.g. `getting-started`. */
  readonly id: string;
  readonly pages: readonly GuidePage[];
}

export function sectionId(section: string): string {
  return section
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The sections that have pages, in nav order. */
export function groupBySection(pages: readonly GuidePage[] = PAGES): GuideSectionGroup[] {
  return SECTIONS.map((section) => ({
    section,
    id: sectionId(section),
    pages: pages.filter((p) => p.section === section),
  })).filter((g) => g.pages.length > 0);
}

export function pageBySlug(slug: string, pages: readonly GuidePage[] = PAGES): GuidePage | null {
  return pages.find((p) => p.slug === slug) ?? null;
}

/** The pages before and after `slug` in nav order. */
export function prevNext(
  slug: string,
  pages: readonly GuidePage[] = PAGES,
): { prev: GuidePage | null; next: GuidePage | null } {
  const i = pages.findIndex((p) => p.slug === slug);
  if (i === -1) return { prev: null, next: null };
  return { prev: pages[i - 1] ?? null, next: pages[i + 1] ?? null };
}
