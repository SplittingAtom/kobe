# KOBE-153: 56a Memory contract: remember/recall, memory API, wire frames

- **Status:** in review
- **Branch / worktree:** `kobe-153-memory-contract` in `../Kobe-wt153`
- **Depends on:** none. Blocks KOBE-154..158. Spec D24; modelled on [KOBE-127](KOBE-127.md).

## Plan

`packages/protocol` only, additive, tests first. Code: `src/memory.ts`, `src/sandbox-wire/memory-frames.ts`.

## Decisions (dependants must follow these names)

- Capability `memory` (`CAPABILITY_MEMORY`). Tools `remember`, `recall` (`MEMORY_TOOLS`, `memoryToolInputSchema`).
- `remember {scope: user|project, path, content, mode?: replace|append}` (mode absent = replace);
  `recall {scope?, path?, query?}`: path (needs scope) reads a file, query searches, neither lists.
- Paths: relative `.md`, max 200 chars, 1-4 segments `[A-Za-z0-9][A-Za-z0-9._-]*`, no `..`.
  Index is `MEMORY.md` (`MEMORY_INDEX_FILE`), max 200 lines (`MEMORY_INDEX_MAX_LINES`); any file max 64 KiB.
  Schema checks index lines of a `replace`; the server must also check the result of an `append`.
- kobe-tools ops `memory.put` / `memory.read` (`memoryToolsRequestSchema`, separate from the artifact
  request schema; kobe-tools dispatches on `op`). Frames `memory.put`, `memory.read` (sandbox -> server,
  default 256 KiB cap is enough), `memory.result` (server -> sandbox, open error code, known
  `MEMORY_ERROR_CODES`). `put` answers `status: applied | pending_approval`.
- **run.start context field: `memory`** (`runMemoryContextSchema`): `{scopes: ("user"|"project")[],
indexes: [{scope, content, version, truncated}]}`. `scopes` = enabled scopes for the run; indexes are
  always loaded, topic files only via `recall`. Sent only to agents announcing `memory`.
- Switches: `memory_enabled`, `project_memory_enabled` (`memorySettingsSchema`), per team (team admins)
  and install-wide (install admins); effective = AND. Disabled scope: absent from `scopes`, server answers
  `memory_disabled`.
- Semantics: user write applies at once (+ `memory.updated`); project write from the agent needs the
  normal signed approval, applied after; panel edits (humans) apply at once.
- `memory.updated` checked for Undo: `memory_doc_id`, `scope`, `path`, `version`, `previous_version`
  suffice. Undo = restore `previous_version` (new version, history kept) or delete when absent
  (`undoMemoryAction`). Added optional `tool_call_id` and `mode` only.
- REST `/v1/memory` (list, get, put with `expected_version`, delete, `:id/restore`, `settings`): schemas
  `memoryDocSummarySchema`, `memoryDocDetailSchema`, `memoryPutRequestSchema`, `memoryRestoreRequestSchema`,
  `memorySettingsSchema`. Project listing takes `project_id`; KOBE-154 decides storage and project identity.

## Open questions

- Project identity (what `project` scope keys on) is left to KOBE-154; the contract only has the scope name.

## Evidence

- ac-1 `packages/protocol/src/memory.test.ts`. ac-2 "memory.updated and Undo" tests. ac-3 `run.start.memory` above and in `memory.ts` header.
