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
- **Routes:** `/docs` and `/docs/<slug>` (`app/docs/[[...slug]]`), a panel over the
  workspace (see "Docs as a panel"); `/docs/<slug>.md` is rewritten (next.config `beforeFiles`) to the handler
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

## Run on gate1 (2026-11-11, coordinator)

Group branch kobe-docs (KOBE-616 viewer + KOBE-617 guide + CLAUDE.md docs rule) deployed with
KOBE-615 merged in (local-33e68a3609da). /llms.txt, /llms-full.txt (110 KB) and /docs answer 200
without a session, text/plain UTF-8, site name from branding. docs, file-editor, thread-file-map,
rail-header and open-file specs: 11 passed.

## Docs as a panel (Chris, 2026-11-11: "open in a panel like the way site admin opens")

- **Mechanism reused, not copied.** The Site console is a route-addressed panel (KOBE-452):
  `lib/shell/panels.ts` maps the `/admin/site` prefix to a panel, the root layout's
  `WorkspaceHost` keeps `ChatApp` mounted for every panel address, and `ChatApp` renders the route's
  page inside `WorkspacePanel` (modal dialog, about 90% of the window, full-screen sheet under
  820 px; Close, Escape and a press outside close it; focus returns to the opener). Docs now gets
  the same by one entry: prefix `/docs` → panel `docs`, title "Docs". The bar's icon is unchanged
  (a Link to `/docs`), so open, close, Back, reload and deep links (`/docs/<slug>`) behave exactly
  like the Site console's.
- **Content:** `app/docs/layout.tsx` lost its standalone header ("Back to Kobe": the panel's Close
  does that) and keeps a "guide home" link; the page body moved to `components/docs/guide-view.tsx`
  (shared by the route and the tests). Guide links are Next `Link`s, so a nav or body link steps
  inside the panel. "View as Markdown" and the llms.txt links open a new tab (plain text would
  otherwise replace the workspace).
- **Opened directly:** `/docs/<slug>` from a link or a reload opens the workspace with the Docs
  panel over it (as `/admin/site` does). Without a session the panel still shows the guide over the
  chat's "Sign in" prompt. `/llms.txt`, `/llms-full.txt` and `/docs/<slug>.md` are route handlers,
  untouched.
- **Evidence:** `components/shell/workspace-panel.test.tsx` ("the Docs panel"), `lib/shell/panels.test.ts`,
  browser spec `e2e/browser/tests/docs.spec.ts` (not run here: needs a deployment).
