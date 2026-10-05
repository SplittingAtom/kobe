# KOBE-129: 55c Server: artifacts tables, storage, wire handler, events and API

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-129-server-artifacts` in `../Kobe-wt129`
- **Depends on:** KOBE-127 (PR #102, contract; this branch is stacked on it until it merges)
- **Design:** [KOBE-55.md](KOBE-55.md) D-1, D-2, D-3, D-5, D-6, D-8

## Plan

1. `packages/db`: `artifacts`, `artifact_versions` (schema `artifacts.ts`, migrations 0066 tables and 0067
   RLS/break-glass/legal hold), tenancy area `workspace`, probe fixtures, `BLOB_REF_COLUMNS`, audit event.
2. Server: `artifacts/` (allowed-call record, put handler, repository, serving helpers), `artifact.put`
   in the sandbox connection, `routes/artifacts.ts`, tool-input schemas, export.

## Decisions

- **Allowed-call record is per connection, in memory** (`artifacts/allowed.ts`): at `policy.result: allow`
  the connection stores `sha256(canonicalJson(input))` under (run, tool_call_id, tool); first allowed input
  wins; bounded (4096, oldest evicted). `artifact.put` must come from the connection that got the allow. A
  reconnect between allow and put fails closed (`not_allowed`); the tool call then errors and the model retries.
- **Check order** (connection): capability, run leased here and live, allow record (tool + hash), then
  `putArtifact` re-checks in Postgres that the run is active, in the frame's thread and owned by the
  sandbox's user, replays an already applied call (unique `(team_id, tool_call_id)`), and for updates requires
  the artifact in the same team and thread.
- **Audit:** new `sandbox.artifact_refused` (team scope; reason, tool, run, tool call id; never content), throttled
  per user and reason like the other wire audits (docs/audit-log.md). Reasons: `capability_missing`,
  `run_not_active`, `not_allowed`, `input_mismatch`, `artifact_not_found`.
- **Storage:** key `<prefix>teams/<team>/threads/<thread>/artifacts/<artifact>/<random uuid>`, derived in
  `artifacts/keys.ts` inside the thread's tree, so retention (`BLOB_REF_COLUMNS` `thread: true`) and export
  need no special case. The random last segment exists because the version number is only known once the
  artifact row is locked, after the upload. An upload orphaned by a refusal or lost race is deleted again.
- **D-5 addition:** `artifact_versions.thread_id` (not in D-5): retention's blob queue and the break-glass/
  legal-hold guards key on `(team_id, thread_id)`; composite FKs to the artifact and the thread keep it right.
  `run_id` has a NO ACTION FK to `runs`.
- **Break-glass:** both tables get a SELECT-only `break_glass_read` policy shaped like `thread_entries`
  (listed in `BREAK_GLASS_READABLE_TABLES`; catalog test has the exact clause). No break-glass read API for
  artifacts yet (the existing one reads threads and entries only).
- **Legal hold:** `AFTER DELETE` statement guards and truncate refusal on both tables (KH001), like entries.
  Thread delete already refuses held threads.
- **Event cap:** at the run's event cap the `artifact.*` event is skipped (the artifact is still stored) so the
  terminal event keeps its room.
- **Frame route:** headers exactly as D-6 in `artifacts/serve.ts` (`FRAME_HEADERS`); `X-Frame-Options` only
  there; `?team=` compared with the session's team like the thread export (409 `team_mismatch`), plus the
  export's cross-site guard (`Sec-Fetch-Site`, `Origin`). Non-html/svg kinds answer 400 `not_frameable`.
- **Export:** per owned thread, `artifacts/<id>/v<n>.<ext>` (kind to extension; code by language, else `.txt`);
  a body that can't be read is left out and logged.
- Not changed: protocol (KOBE-127), the web, the sandbox agent.

## Open questions (for Chris or the coordinator)

- Break-glass read API for artifacts (policies exist; no endpoint) if D10 reviewers should see them.
- The artifact routes are not in the OpenAPI document (it covers threads and runs only).

## Evidence (acceptance criteria to test)

- Cross-team probe suite green with the new tables: `packages/db/src/probe.db.test.ts`, `catalog.db.test.ts`
  (RLS, break-glass clause, team_id index), `artifacts.db.test.ts` (constraints, cascade, legal hold).
- `artifact.put` refusals audited: `services/server/src/artifacts.db.test.ts`, "refusals (D-3)": no capability,
  never allowed, denied by policy, other input, other tool, ended run, other thread, other team, no content in audit.
- Events and API, S3 content, retention purge and export: same file, "create and update", "/v1/artifacts",
  "retention and export"; tool-input schemas: `policy/tool-inputs.test.ts`.
