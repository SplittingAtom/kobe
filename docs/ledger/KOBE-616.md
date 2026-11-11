# KOBE-616: Kobe guide viewer, Docs icon and llms.txt

- **Status:** in review (branch, no PR yet)
- **Branch / worktree:** `kobe-616-docs-viewer` in `../Kobe-wt616`
- **Depends on:** KOBE-617 writes the content in `docs/guide/` (two seed pages here: `getting-started`, `glossary`)

## Plan

Plumbing only: build step, viewer at /docs, the bar's Docs icon, agent-facing text routes.

## Decisions

- **Compiled in at build time.** `apps/web/scripts/generate-guide.mjs` reads `docs/guide/**/*.md`
  and writes `apps/web/lib/docs/guide.generated.ts` (gitignored) through
  `lib/docs/guide-loader.ts` (self-contained so Node runs it directly). It runs before `next build`,
  `next dev`, typecheck and the tests. Nothing is read from outside the app at runtime.
- **Rebuilds:** `apps/web/turbo.json` adds `../../docs/guide/**` to the web's build/test/typecheck
  inputs; `.dockerignore` re-includes `docs/guide` (it excluded `docs` and `*.md`); the web
  Dockerfile copies the whole context, so no Dockerfile change.
- **Contract checks (fail the build, all problems listed):** missing title/summary/section, unknown
  section or audience, bad file name, duplicate slug, a relative link that is not a guide `.md`
  page or leaves `docs/guide`, a root-relative `/docs/...` link. A leading `# Title` is dropped
  (the viewer and the Markdown outputs print the title).
- **Routes:** `/docs` and `/docs/<slug>` (`app/docs/[[...slug]]`), a page of its own outside the
  workspace; `/docs/<slug>.md` is rewritten (next.config `beforeFiles`) to the handler
  `app/guide-md/[...slug]`; `/llms.txt` and `/llms-full.txt` are route handlers.
- **Auth:** the web has no server-side auth gate (pages fetch their data from the server's API with
  the cookie; the chat shows "Sign in" itself). All guide routes, `/docs` included, are readable
  without a session: the guide is static product text with no team or user data.
- **Origin for absolute links:** `KOBE_PUBLIC_URL` (the chart now passes the server's value to the
  web too), else `X-Forwarded-Proto`/`-Host`, then `Host`. App name: site branding (`Kobe` default).
- **Caching:** `public, max-age=300, must-revalidate` + weak ETag (FNV-1a of the body; 304 on match).
- **Markdown:** the chat's `Markdown` got `variant="guide"`: same-tab links to app paths and `#`
  anchors, ids + anchor links on h2–h4; the chat's own behaviour is unchanged (tested).
- **llms.txt:** "For agents" first, then sections in order; no `## Optional` section.

## Open questions (for Chris or the coordinator)

- None blocking. KOBE-617 must follow the contract (relative `.md` links only).

## Evidence (acceptance criteria → test or command output)

- ac-1 Docs icon: `components/docs/docs.test.tsx` ("the Docs icon"); `lib/shell/commands.ts` id `docs`.
- ac-2 viewer: `components/docs/docs.test.tsx` (nav, filter, phone fold, guide Markdown);
  `lib/docs/guide.test.ts`; standalone server curl: `/docs`, `/docs/glossary` 200, unknown 404.
- ac-3 View as Markdown + llms links with copy buttons: `app/docs/[[...slug]]/page.tsx`, browser spec.
- ac-4 text routes: `lib/docs/llms.test.ts`, `lib/docs/public-origin.test.ts`; curl against the
  standalone build: 200, `text/plain`/`text/markdown; charset=utf-8`, ETag, 304; nested slugs work.
- ac-5 failures: `lib/docs/guide-loader.test.ts`, `lib/docs/generate-guide.test.ts` (exit 1).
- ac-6 browser spec: `e2e/browser/tests/docs.spec.ts` (not run here: needs a deployment).
- Chart: `charts/kobe/tests/web-server-url.test.ts` (KOBE_PUBLIC_URL on the web).
