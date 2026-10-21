# KOBE-473: Viewed file: only the current run carries it

- **Status:** in review (not pushed; group branch `group-23-viewing-latest`)
- **Spec:** FE7 in `docs/specs/file-editor.md` now states the rule.

## Findings

- The rule holds; no code change. Pi 1.0.0 projects a `before_agent_start` prompt onto each
  request of that run only (`_runSystemPromptOptions`, cleared when the run settles) and persists
  only the structured sections, so the session never holds the fence. The agent rewrites
  `memory-context.json` before every run (`viewing: ""` without one); compaction never fires
  `before_agent_start` and uses Pi's summary prompt.
- Context viewer: the header fallback finds each part at most once, so at most one `viewing_file`.

## Evidence

- ac-1: `src/kobe-tools.viewing.real-pi.test.ts` (runs a.md → b.md → none → restarted Pi, counts
  needles in the model's system prompt via faux `countInSystem`); `memory/viewing-context.test.ts`.
- ac-2: same real-Pi test: session JSONL and every frame to the server lack the fence, header,
  text and paths.
- ac-3: FE7. Viewer: `context/sections.test.ts` "at most one viewed-file section".
