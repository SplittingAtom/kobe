# KOBE-462: File editor: save route, viewed-file context and propose_file_edit (server + protocol)

- **Status:** in review (group branch, no PR yet)
- **Branch / worktree:** `group-15-file-editor` in `../Kobe-wt462`
- **Depends on:** nothing; KOBE-463 (web editor) builds on it.
- **Spec:** [docs/specs/file-editor.md](../specs/file-editor.md) (FE1–FE12).

## Plan

1. Protocol contract (`packages/protocol/src/file-editor.ts`, frames, event, capability).
2. Save route (`PUT /v1/workspace/file`), reusing the upload's blob path and checks.
3. `runs.viewing` (migration 0168) and the viewed-file note through `run.start.viewing`.
4. `propose_file_edit`: server wire handler, proposal event, owner read route.
5. sandbox-agent: kobe-tools tool, broker, capability, viewed file in the run's prompt.

## Decisions

- Version = SHA-256 of the synced copy (already on listing/search entries); `base_sha256` in the
  save query; 409 `version_conflict` with `current` (null when gone). Unchanged content: no
  revision. Only existing files are saved (new files are uploads).
- Save body is the raw bytes (no JSON), same size limit as the upload; shared `storeBlob` in
  `workspace-files/upload.ts` (now takes a write function: copy for uploads, put for saves).
- Team quota judged on the size change (`teamStorageAllows`, shrinking always passes).
- Viewing is read **at submit** (what the member saw), kept on the run (`runs.viewing`, never in
  the message text or events), re-sent by a retry. 32 KiB, text only. Missing/internal: no note.
- In the prompt: verbatim text between nonce markers (`<<<BEGIN VIEWED FILE n>>>`), not the memory
  sanitiser (it would make proposals rewrite characters). Rides the per-run memory file.
- `propose_file_edit` is risk `read` (writes nothing): no ask-on-write prompt; deny/ask rules and
  ask-all still apply. Bound to its allowed check, single use (`consume`).
- Proposal record = the `file.edit_proposed` run event (as `skill.draft_saved`, KOBE-442 L4);
  `GET /v1/threads/{id}/file-edit-proposals` for the owner only. Lost with D18 compaction (7 days
  after the run): accepted, the card says expired.
- Base of a proposal = the run owner's synced copy at proposal time; nothing pushed first. An
  unsynced file is `not_found` (the agent saves it first).
- Content cap 128 KiB so a proposal fits one run event (256 KiB JSON); an escaped payload over the
  event cap is `too_large`.
- The Kobe gallery agent's text is unchanged: the tool's Pi guidelines and the viewed-file section
  carry the "propose, don't edit" instruction (no agent version bump).
- Refusals of `file.edit_propose` are logged (security) and answered, not audited (no write).

## Open questions (for Chris or the coordinator)

- Migration 0168 (`runs.viewing`) is in its own commit (`feat(db): runs.viewing …`): land it first
  per docs/parallel-work.md, or merge with the group.
- Protocol contract is its own commit (`feat(protocol): …`) for the "contract first" rule.
- Proposals vanish with run-event compaction after 7 days; a durable table is possible later.

## Evidence (acceptance criteria → test or command output)

- ac-1: `docs/specs/file-editor.md` (FE1–FE12, shapes for KOBE-463).
- ac-2: `services/server/src/workspace-save.db.test.ts` (8: version check, 409 current/null,
  unchanged, other member, read-only/internal/bad query, size + workspace + team quota, racing
  saves + executable bit, audit); `workspace-files.db.test.ts` still green (upload refactor).
- ac-3: `services/server/src/file-viewing.db.test.ts` (7: run.start.viewing, not in message,
  32 KiB truncation, binary, own workspace only, capability gate, retry, bad path 400);
  `workspace-files/viewing.test.ts`; sandbox-agent `memory/viewing-context.test.ts`,
  `kobe-tools/memory-hooks.test.ts`; `packages/db/src/runs-viewing-upgrade.db.test.ts`.
- ac-4: `services/server/src/file-edit-propose.db.test.ts` (4: event recorded and nothing
  written, owner-only read route, path refusals, capability/allowance/single use);
  `policy/evaluate.test.ts` (4 cases); sandbox-agent `kobe-tools/file-edit-tool.test.ts`,
  `tools/file-edit-broker.test.ts`, `kobe-tools.file-edit.real-pi.test.ts` (real Pi 1.0.0);
  protocol `file-editor.test.ts`.
- `pnpm verify` steps all green: format, lint, typecheck, license:check, hygiene, site wording;
  unit tests via `turbo run test --concurrency=2` (full parallel `pnpm test` hit load timeouts in
  unrelated chart/protocol/pi-parity tests, each green alone); `@kobe/server test:db` 173 files /
  2128 tests, `@kobe/db test:db` 88 / 1551. Real-Pi suites ran locally (Pi 1.0.0 installed).
