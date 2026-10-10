# KOBE-156: 56d Server remember/recall handler, project approval, switches

- **Status:** in review
- **Branch / worktree:** `kobe-156-remember-recall-handler` in `../Kobe-wt156`
- **Depends on:** [KOBE-153](KOBE-153.md) (contract), [KOBE-155](KOBE-155.md) (service), KOBE-161 (membership, PR #176). No migration.

## Plan

Server only. `memory/agent.ts` (put, read, `run.start.memory`), `#onMemoryPut` / `#onMemoryRead` in
`sandbox-wire/connection.ts`, `run.start.memory` in `delivery.ts`. Tests first: `memory-agent.db.test.ts`.

## Decisions

- **Gate on the connection** (as `artifact.put`): capability `memory`, run leased and active, and for
  `memory.put` the `remember` call allowed by this connection's policy check with the same canonical input
  hash (`remember` joins `BOUND_TOOLS`). `memory.read` is a read: capability and lease only. The database
  re-checks run active/owner, switches and membership in the write transaction.
- **Personal** writes apply at once: `writeMemory` (actor agent, run and tool call recorded), audit
  `memory.written`, `memory.updated` (doc, path, version, previous_version, tool_call_id, mode). Idempotent on
  (run, tool call): a repeat answers the stored version (advisory lock per call, lookup in
  `memory_doc_versions`; no index on `(run_id, tool_call_id)`, fine at this volume).
- **Project** = the thread's project (never sent by the sandbox); user must pass `canAccessProject`.
  Approval: if the policy check already got a signed approval for the call, `ApprovalVerifier.authorize`
  (HMAC over run, tool call and canonical input) verifies and consumes it and the write applies at once
  (`applied`). Otherwise the broker creates the approval (card, run `waiting_approval`), the sandbox gets
  `pending_approval`, and on approval the write is verified, consumed and applied with `memory.updated`.
  Denied, expired or ended: nothing is written, `sandbox.memory_refused` `approval_denied`.
  This holds in every approval mode (auto and scheduled runs too: a project write is never silent).
- **Needed a change in `approvals/decide.ts`:** a decision used to mark every non-MCP approval consumed at once
  (the sandbox enforces it). Project `remember` is now left unconsumed so the memory handler consumes it, as the
  MCP proxy does for MCP tools.
- **Policy fix:** the personal-`remember` exemption looked for `scope: "personal"`; the contract says `user`
  (`policy/settings.ts`, tests). Before this a personal `remember` would have prompted.
- **Switches:** `scopeEnabled` logic of `readSwitches` (install AND team; project needs memory too). Disabled:
  `memory_disabled` for put and read; `read` without a scope skips disabled scopes.
- **`run.start.memory`:** built at delivery for agents with `memory` (`buildRunMemory`): enabled scopes
  (project only with a project the user belongs to) and each `MEMORY.md` (200 lines, `truncated`, version 0 and
  empty when absent). A failed read sends no context (calls are still enforced). Memory off: `{scopes:[],indexes:[]}`.
- **recall:** `path` reads one live file; `query` is a case-insensitive substring over path and content of at most
  200 docs, 20 files and 256 KiB of content (`truncated`); neither lists paths (no content).
- **Audit:** `memory.written` (actorKind agent); new `sandbox.memory_refused` (op, reason, scope; throttled
  1/5 min per user, op, reason). Never paths or content.
- **Test seam:** `SandboxWireOptions.projectAccess` replaces `canAccessProject` in tests (membership by a set);
  until #176 merges the real function is always false.

## Open questions

- Scheduled runs: a project write waits up to 1 h for a human who may not be there. Allow-list instead?
- Index on `memory_doc_versions (team_id, run_id, tool_call_id)` for replay lookups (needs a migration).
- After merging #176: add a test with real `project_members` rows (the seam test covers the logic now).

## Evidence

- ac-1: "remember and recall work end to end..." (`memory-agent.db.test.ts`).
- ac-2: "project memory" block (approval waits, denied, policy-approved, non-member, no project, switch off).
- ac-3: "run.start.memory" block.
