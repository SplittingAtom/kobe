# KOBE-89: Five gallery agents with e2e sample tasks

- **Status:** in review
- **Branch / worktree:** `kobe-89-gallery-agents` in `../Kobe-wt89`
- **Depends on:** KOBE-87 (gallery mechanism), KOBE-88 (built-in skills), KOBE-85 (system prompt reaches Pi)
- **Migrations / endpoints:** none.

## Acceptance criteria

- **ac-1 Each gallery agent completes its sample task in e2e.** `e2e/run.sh` section "gallery agents
  (KOBE-89)", real sandbox, fake model. See Evidence.
- **ac-2 Researcher works when web search is unconfigured.** Nothing in the Researcher needs a search
  tool; its prompt makes it say so first (below). Asserted in e2e and in the definitions unit test.

## Decisions

- **Definitions** live in `services/server/src/gallery/agents/<key>.ts` (one agent file per module),
  listed in `GALLERY_DEFINITIONS`, all `generation: 1`. Keys/slugs: `assistant`, `data-analyst`,
  `researcher`, `document-drafter`, `code-helper`. Raise a generation with any change to a file.
- **No model pinned** in any of them: the thread's chosen model or the team default applies.
- **Skills** (built-ins from KOBE-88, unioned with the user's enabled skills as for any agent):
  Assistant none; Data Analyst `data-analysis`, `charts`, `xlsx`; Researcher `pdf`, `docx`, `xlsx`
  (reads provided material); Document Drafter `docx`, `pdf`; Code Helper `code-review`.
  All six scripts run offline (KOBE-88 checks them under `--network none`).
- **Document Drafter ships without artifact output.** Its prompt has it write Markdown, convert with
  docx (default) or pdf, verify by reading the file back, save it in the workspace and name it.
  KOBE-55 adds artifact output later (new generation).
- **Researcher degrades gracefully.** No web search exists (KOBE-63 not built). The prompt says: use
  a web search tool only if one is listed; otherwise open the first reply with the exact sentence
  `RESEARCHER_NO_SEARCH_NOTICE` ("Web search is not available here, so I can only work from the
  material you give me."), never pretend to search, cite only what was read. When KOBE-63 lands, the
  rule keeps working (the tool then appears in its tool list) and the sentence is just not used.
- **"Assistant (default)".** The existing model has no "default agent": a chat with no agent is the
  install default, and the KOBE-122 picker (PR #88, still open) preselects "No agent". So the Assistant
  is "the default" only by convention (general purpose, no extra skills, first in the gallery
  list). **Follow-up, not built:** preselecting it in the picker or making it the install default
  agent needs a decision on the model (no new mechanism invented here).
- **Fake model addition** (`fake-llm.ts`): a last user message `system?` echoes the system/developer
  messages on one line. Kept (unit-tested) as a debugging aid; see the finding below.

## Open questions

- **FINDING: the agent's system prompt does not reach Pi in the sandbox.** CI e2e showed Pi's system
  message is only its built-in one. `sandbox-agent/src/pi/pi-launch.ts` puts `config.system_prompt` in
  the launch key but passes it nowhere ("seams, not wired", KOBE-47). The server sets it (KOBE-85), so
  today the five agents differ by skills only, and the Researcher's notice is not enforced at run time.
  Not fixed here (sandbox-agent change, outside this ticket); needs its own ticket (e.g. Pi
  `--append-system-prompt`). The e2e therefore asserts the published prompt, not the model's view.
- Preselecting the Assistant (follow-up above).
- The e2e runs the skills in the agent's sandbox through a scripted bash tool call (the fake model
  cannot decide to use a skill itself); Pi's registration of a skill is covered by KOBE-88 tests.
- The k3d e2e cannot run on the dev Mac; its result is the CI `e2e` job on the PR.

## Evidence

- Unit: `services/server/src/gallery/definitions.test.ts` (five keys, generation 1, no model, only
  built-in skills, per-agent skills, Researcher notice, Drafter has no artifact output);
  `services/model-gateway/src/fake-llm.test.ts` (system echo).
- e2e (`e2e/run.sh`, k3d + gVisor, CI `e2e`): per agent, a thread with `agent_id` runs in the Owner's
  real sandbox on the team default model. Assistant returns its text and its prompt reaches the model;
  Data Analyst profiles the sample CSV and writes a PNG; Researcher completes with no search tool,
  its published prompt holds the unavailable sentence, and it extracts docx text offline; Document Drafter produces .docx and .pdf;
  Code Helper scan reports 4 findings.
- `pnpm verify`, `test:db`, CI: see PR.
