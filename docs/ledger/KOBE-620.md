# KOBE-620: KA-3 docs tools, `@kobe/guide` and the `kobe-guide` skill

- **Status:** committed on `kobe-620-docs-tools` (on top of KOBE-618/619 and current main)
- **Branch / worktree:** `kobe-620-docs-tools` in `../Kobe-wt620`
- **Depends on:** KOBE-619 (KA-2 host), KOBE-616 (the guide); spec `docs/specs/kobe-admin-mcp.md`
  §4, §11 KA-3, decisions KA4, KA7

## What landed

- **`packages/guide` (`@kobe/guide`)**: the guide build moved out of `apps/web/lib/docs` (loader and
  frontmatter checks, generator, `llmsTxt`/`llmsFullTxt`/`pageMarkdown`, page lookups, heading
  anchors as `@kobe/guide/headings`), plus `searchGuide` (titles, summaries, h2–h4 headings; every
  word must match; title > heading > summary; capped at 20) and `llmsFullTxt(..., section)`.
  `scripts/generate-guide.mjs` writes `src/generated/pages.ts` (gitignored) before build, test and
  typecheck; the build still fails on bad frontmatter, unknown sections, duplicate slugs and broken
  links (tests moved with it). `packages/guide/turbo.json` lists `../../docs/guide/**` as inputs
  (the web's turbo.json went: web depends on the package's hash). Both images `COPY . .` with
  docs/guide re-included in `.dockerignore`, and `pnpm turbo run build --filter=@kobe/server...`
  now builds `@kobe/guide`; `pnpm deploy` ships its `dist`.
- **Web**: `lib/docs/guide.ts` and the text half of `lib/docs/llms.ts` re-export the package;
  ETag/`textResponse` stay in the web. Scripts no longer run a generator.
- **Docs tools** (`services/server/src/kobe-mcp/docs/`): `docs_index`, `docs_page {slug}`,
  `docs_full {section?}` (256 KiB cap, else "pass a section"), `docs_search {query, limit?}`.
  Rendered with `KOBE_PUBLIC_URL`'s origin and `readAppName` (the site branding), so `docs_index`
  is the web's `/llms.txt` for the same origin and branding. `docs_page` looks the slug up among
  built pages (accepts `x`, `x.md`, `/docs/x.md`, the full URL); unknown → tool error
  `unknown_page`; nothing is read from a path. Text tools declare no output schema (no
  `structuredContent`); search returns structured results.
- **Every run (KA7)**: `kobe-mcp/run.ts` `kobeRunServer` always attaches the docs tools while the
  site switch is not `off` and the thread has not turned the connector off; admin tools still need
  the agent's `kobe`/`all`, an answerable run and the person's permission. `runs/agents.ts` now
  calls it for runs without an agent too (docs only), so `run.start.mcp` / `mcp_connector_ids`
  carry the built-in on every run. The service lists docs tools for every run that has the
  connector (scheduled, eval, auto) and runs them in process after `decideMcpCall` (audited like
  any MCP call).
- **`kobe-guide` skill** (`services/server/builtin-skills/kobe-guide/`, 1.0.0, hashes appended in
  `kobe-packages.test.ts`), added to `KOBE_SKILL_NAMES` (protocol and db) and to the Kobe gallery
  agent (generation 4, one line in its prompt). The existing Kobe seed publishes it Default and
  queues the `add` sync, so every team gets it (covered by `kobe-skills.db.test.ts`, now counting
  `KOBE_SKILL_NAMES`). Migration `0208_kobe_guide_skill_name` widens `registry_skills_kobe_names`.
- **Guide**: `for-agents/reading-the-docs.md` rewritten (in-sandbox agents: kobe connector's docs
  tools + kobe-guide skill; outside Kobe: `/llms.txt`; fixed the stale "pages start with YAML
  front matter" line), one paragraph each in `working-in-a-sandbox.md` and `concepts.md`.

## KA-2 framework code touched (and why)

- `policy/kobe-admin-guard.ts`: new `isKobeAdminTool` (built-in tool other than `docs_*`); the
  guard and `person-guard.ts` apply only to admin tools, else docs calls were denied in scheduled
  runs/evals and for members.
- `kobe-mcp/pinned.ts`: `kobePinnedTool` accepts docs tools (output schema optional; admin tools'
  hashes unchanged); `kobePinnedTools`/`kobeConnector` include the docs tools, always enabled.
- `kobe-mcp/service.ts`: lists docs for every run, skips the person check and limits for docs,
  executes docs tools; `structuredContent` optional; new required option `publicUrl` (deps.ts).
- `kobe-mcp/limits.ts`: docs calls excluded from the admin read count.
- `kobe-mcp/run.ts`: rewritten as above. `kobe-mcp.db.test.ts`: listings now include the docs tools.

## Decisions

- The agent's own tool globs (`tools.allow`/`deny`) still filter the docs tools: KA7 says
  "whatever the agent's connector list", and the engine's `checkAgentTools` would deny a call
  outside `tools.allow` anyway. An agent with a narrow `tools.allow` gets no docs tools unless it
  lists `mcp__kobe__docs_*`.
- Site switch `off` removes the docs tools too (§6: `off` = no `kobe` connector).
- Byte-equality: `packages/guide/test/fixtures/expected` was written by the web code before the
  move (fixture guide, `Acme Chat` / `https://chat.example.com`); the real guide's 27 outputs were
  also compared before/after the move with docs unchanged (identical). The web test asserts the
  routes answer exactly the package's texts.

## Open questions / risks

- Migration 0208 fails if a non-Kobe registry skill is already named `kobe-guide` (none expected).
- Every docs call writes an `mcp.tool_call` audit row (as any MCP call).

## Evidence

- ac-1: `packages/guide/src/golden.test.ts`, `apps/web/lib/docs/llms.test.ts`,
  `packages/guide/src/{loader,generate-guide}.test.ts`.
- ac-2: `services/server/src/kobe-mcp/docs/docs.test.ts`; `kobe-mcp.db.test.ts` "the docs tools"
  (index equals llms.txt incl. app name, unknown/traversing slug, auto/scheduled/eval with site
  `docs` and team docs only, no admin-limit counting, KA7 run wiring);
  `policy/kobe-admin-guard.test.ts` docs case.
- ac-3: `skills/kobe-packages.test.ts`, `kobe-skills.db.test.ts`, `gallery/definitions.test.ts`.
- ac-4: `docs/guide/for-agents/*.md`.
