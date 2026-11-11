/**
 * KOBE-616: `/docs/<slug>.md` (any depth) is served by the route handler under /guide-md, which
 * gets the `.md` path and strips it; the /docs/[[...slug]] page renders every other /docs path.
 */
export const GUIDE_MARKDOWN_REWRITE = {
  source: "/docs/:path(.+\\.md)",
  destination: "/guide-md/:path",
} as const;
