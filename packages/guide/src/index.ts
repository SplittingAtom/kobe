/**
 * `@kobe/guide` (KOBE-620): the Kobe user guide (docs/guide) built into typed pages at package
 * build time, and the texts made from it: `/llms.txt`, `/llms-full.txt`, `/docs/<slug>.md` and
 * the docs search. Used by the web routes and the server's docs tools, so both serve identical
 * bytes from the same release. `@kobe/guide/headings` is the viewer's heading-anchor step.
 */
export {
  AUDIENCES,
  buildGuide,
  GuideBuildError,
  ORIGIN_TOKEN,
  SECTIONS,
  type GuideAudience,
  type GuideFile,
  type GuidePage,
  type GuideSection,
} from "./loader.js";
export {
  groupBySection,
  pageBySlug,
  PAGES,
  prevNext,
  sectionId,
  type GuideSectionGroup,
} from "./pages.js";
export { llmsFullTxt, llmsTxt, pageMarkdown, pageMarkdownUrl, type LlmsContext } from "./llms.js";
export {
  pageHeadings,
  searchGuide,
  SEARCH_MAX_RESULTS,
  type GuideHeading,
  type GuideSearchHit,
} from "./search.js";
