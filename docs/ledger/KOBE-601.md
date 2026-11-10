# KOBE-601: keep reasoning.summary on Responses rewrites

Branch `kobe-601-reasoning-summary` (worktree `Kobe-wt601`), from origin/main 5f629f30.

## Done

- `services/model-gateway/src/thinking.ts`: `reasoningSummary` reads the caller's
  `reasoning.summary` as Bifrost's decoder would (case-insensitive `reasoning` keys merge, a later
  `null` clears, last `summary` wins) and keeps it only if it is `auto`, `concise` or `detailed`.
  For `reasoning_effort` on `/v1/responses` the gateway now writes `reasoning {effort, summary}`;
  every other reasoning member and field is still stripped. Level `off` (`effort: none`) writes no
  summary. Chat Completions unchanged (no summary field there).
- `thinking.test.ts`: allowed values kept, invalid values dropped, other members/fields stripped,
  off/no-summary cases, decoder semantics, Chat Completions unchanged; the S1 "sneaky" Responses case
  now expects the valid summary kept.
- Docs: `docs/design/bifrost-request-rewrite.md` (section 2 note, section 3 row, follow-ups) and
  the mapping row in `docs/design/thinking-controls.md`.

## Evidence (ac-2)

`tools/bifrost-capture` against the pinned v2.2.5 image on the remote Docker host, 2026-11-10:
gpt-5.1 Responses at low/medium/high forwarded upstream `reasoning {effort, summary: "auto"}`;
off forwarded `{effort: none, summary: null}` (Bifrost default). Ollama Responses converts to Chat
Completions and drops the summary (Bifrost, unchanged). The DUP case still merges as documented.

## Decisions taken

- Summary dropped at level `off`: nothing to summarise, and it keeps `effort: none` bodies as before.
- Values compared exactly (lowercase), as the OpenAI enum is case-sensitive.
