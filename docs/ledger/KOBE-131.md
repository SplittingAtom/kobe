# KOBE-131: 55e Gallery agents use artifacts + end-to-end check

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-131-gallery-artifacts-e2e` in `../Kobe-wt131`
- **Depends on:** KOBE-127..130 (merged)

## Plan

Prompts of three gallery agents, generations raised, tests first; an e2e section with the fake model
calling `create_artifact` / `update_artifact`; KOBE-55 evidence.

## Decisions

- **Generations:** assistant 2 to 3, data-analyst 1 to 2, document-drafter 1 to 2 (researcher and
  code-helper unchanged). Seeding replaces a gallery agent only when the generation is newer.
- **Prompts:** Data Analyst builds a self-contained HTML chart (no external resources) with
  `create_artifact` and still draws a PNG with the charts skill and saves files when asked; Document
  Drafter keeps writing docx/pdf and adds a Markdown artifact preview (`update_artifact` for revisions);
  Assistant uses an artifact for HTML, diagrams, tables and code files and keeps short answers in chat.
  The Drafter's "no artifact output until KOBE-55" comment and test are gone.
- **Tool access:** no agent sets `tools.allow`, and both tools are in `BUILTIN_TOOLS`, so the frozen
  manifests include them; `definitions.test.ts` asserts it with `computeToolManifest`.
- **Fake model:** `tool: <name> <json>` answers with a call of that tool. The call id is a hash of the
  prompt, because the server dedupes `artifact.put` by tool call id (a fixed id would make the update
  return the create's result).
- **e2e:** `CHAT_JS` got an optional thread id (an update must stay in its thread) and prints the
  `artifact.created/updated` events it saw. The section creates an HTML artifact with an inline script
  through the Data Analyst, then checks the event, the list, the content bytes, the `/frame` headers
  (CSP `sandbox allow-scripts allow-forms`, `connect-src 'none'`, `X-Frame-Options: SAMEORIGIN`), then
  updates it to version 2 (artifact writes are approval-gated in ask-on-write, `riskClassPrompts`, so `CHAT_JS` takes an approve-all flag and allows pending approvals; the first CI run hung on that) and checks the detail lists two versions. Not run locally (CI's e2e job).

## Open questions (for Chris or the coordinator)

- KOBE-55's ac-1..3 text is in Hadron (not touched); evidence in `KOBE-55.md` follows KOBE-130's mapping
  (render and headers, versions and download, reopen).
- The in-browser render of the frame is covered by unit tests and the real headers, not a browser e2e.

## Evidence (acceptance criteria → test or command output)

- Definitions tests and generations: `services/server/src/gallery/definitions.test.ts`.
- e2e create/read/frame/update: `e2e/run.sh` section "artifacts (KOBE-131)"; fake model:
  `services/model-gateway/src/fake-llm.test.ts`.
- KOBE-55 ac-1..3: `docs/ledger/KOBE-55.md` "Evidence".
